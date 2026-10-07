#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import egressProtocol from "./egress-protocol.json" with { type: "json" };
import { attachDownstreamRuntime, attachRequestRuntime } from "./node-transport-adapter.mjs";
import { createTransportLifecycle } from "./transport-lifecycle.mjs";

const ALLOWED_POST_PATHS = new Set(["/responses", "/responses/compact"]);
const ACCOUNT_READ_PATHS = new Map([
  ["/account/usage", "../wham/usage"],
  ["/account/profile", "../wham/profiles/me"],
  ["/account/rate-limit-reset-credits", "../wham/rate-limit-reset-credits"]
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const FORBIDDEN_MANIFEST_NAMES = new Set([
  ...HOP_BY_HOP_HEADERS,
  "host",
  "content-length",
  egressProtocol.manifestHeader,
  egressProtocol.secretHeader,
  egressProtocol.transportTrace.header
]);
const RESPONSE_HEADER_DENYLIST = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  "chatgpt-account-id",
  "content-length",
  "cookie",
  "set-cookie",
  egressProtocol.secretHeader,
  egressProtocol.manifestHeader,
  egressProtocol.transportTrace.header
]);
const TRANSPORT_TRACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRODUCTION_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex";
const ALLOW_INSECURE_LOCAL_UPSTREAM = "1";

const bindHost = process.env.BIND_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "8789", 10);
const upstreamBaseUrl = readUpstreamBaseUrl();
const egressSecret = process.env.CODEX_EGRESS_SECRET ?? "";

function readUpstreamBaseUrl() {
  const configured = process.env.CODEX_UPSTREAM_BASE_URL?.trim();
  if (!configured) {
    process.stderr.write("CODEX_UPSTREAM_BASE_URL is required\n");
    process.exit(1);
  }
  const normalized = configured.replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    process.stderr.write("CODEX_UPSTREAM_BASE_URL is invalid\n");
    process.exit(1);
  }
  const hasCredentialsOrQuery = Boolean(
    parsed.username || parsed.password || parsed.search || parsed.hash
  );
  const isProductionTarget = (
    normalized === PRODUCTION_UPSTREAM_BASE_URL
    && parsed.protocol === "https:"
    && parsed.hostname === "chatgpt.com"
    && parsed.pathname === "/backend-api/codex"
    && !hasCredentialsOrQuery
  );
  const isExplicitLocalTestTarget = (
    process.env.CODEX_ALLOW_INSECURE_LOCAL_UPSTREAM === ALLOW_INSECURE_LOCAL_UPSTREAM
    && parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    && !hasCredentialsOrQuery
  );
  if (!isProductionTarget && !isExplicitLocalTestTarget) {
    process.stderr.write("CODEX_UPSTREAM_BASE_URL is not an allowed target\n");
    process.exit(1);
  }
  return normalized;
}

if (!egressSecret) {
  process.stderr.write("CODEX_EGRESS_SECRET is required\n");
  process.exit(1);
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  process.stderr.write("PORT must be a valid TCP port\n");
  process.exit(1);
}

function hasValidSecret(request) {
  const values = request.headersDistinct[egressProtocol.secretHeader] ?? [];
  if (values.length !== 1) {
    return false;
  }
  const provided = values[0];
  const actual = Buffer.from(provided);
  const expected = Buffer.from(egressSecret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

class ManifestError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function parseManifest(request) {
  const values = request.headersDistinct[egressProtocol.manifestHeader] ?? [];
  if (values.length === 0) {
    throw new ManifestError(egressProtocol.errors.missingManifest);
  }
  if (values.length !== 1) {
    throw new ManifestError(egressProtocol.errors.duplicateManifest);
  }

  let names;
  try {
    names = JSON.parse(values[0]);
  } catch {
    throw new ManifestError(egressProtocol.errors.invalidManifest);
  }
  if (!Array.isArray(names) || names.length === 0) {
    throw new ManifestError(egressProtocol.errors.invalidManifest);
  }
  const headerName = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
  if (!names.every((name) => typeof name === "string" && headerName.test(name))) {
    throw new ManifestError(egressProtocol.errors.invalidManifest);
  }
  const normalized = [...new Set(names)].sort();
  if (normalized.length !== names.length || normalized.some((name, index) => name !== names[index])) {
    throw new ManifestError(egressProtocol.errors.invalidManifest);
  }
  const connectionOwnedNames = new Set(
    String(request.headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
  if (names.some((name) => FORBIDDEN_MANIFEST_NAMES.has(name) || connectionOwnedNames.has(name))) {
    throw new ManifestError(egressProtocol.errors.internalManifest);
  }
  if (names.some((name) => request.headers[name] === undefined)) {
    throw new ManifestError(egressProtocol.errors.unsatisfiedManifest);
  }
  return names;
}

function selectedRequestHeaders(request, manifestNames) {
  return Object.fromEntries(manifestNames.map((name) => [name, request.headers[name]]));
}

function transportTraceMetadata(request) {
  const values = request.headersDistinct[egressProtocol.transportTrace.header] ?? [];
  if (values.length === 0) {
    return {
      transport_trace_id: null,
      transport_trace_status: egressProtocol.transportTrace.traceStatuses.missing
    };
  }
  if (values.length !== 1 || !TRANSPORT_TRACE_ID_PATTERN.test(values[0])) {
    return {
      transport_trace_id: null,
      transport_trace_status: egressProtocol.transportTrace.traceStatuses.invalid
    };
  }
  return {
    transport_trace_id: values[0],
    transport_trace_status: egressProtocol.transportTrace.traceStatuses.ok
  };
}

function createJsonLineOutcomeSink(writeLine) {
  return {
    emit(event) {
      writeLine(`${JSON.stringify(event)}\n`);
    }
  };
}

const transportOutcomeSink = createJsonLineOutcomeSink((line) => process.stderr.write(line));

function emitTransportEvent(outcomeSink, eventKind, event) {
  const allowlist = egressProtocol.transportTrace.eventFields[eventKind];
  const allowlistedEvent = Object.fromEntries(
    allowlist
      .filter((field) => Object.hasOwn(event, field))
      .map((field) => [field, event[field]])
  );
  try {
    outcomeSink.emit(allowlistedEvent);
  } catch {
    // A replacement or production sink must never change the proxied transport.
  }
}

function headerNameIsolationEvidence(receivedNames, selectedNames) {
  receivedNames = receivedNames.map((name) => name.toLowerCase()).sort();
  selectedNames = selectedNames.map((name) => name.toLowerCase()).sort();
  const selectedNameSet = new Set(selectedNames);
  return {
    received_names: receivedNames,
    selected_names: selectedNames,
    removed_names: receivedNames.filter((name) => !selectedNameSet.has(name))
  };
}

function headerIsolationEvidence(request, manifestNames) {
  return {
    manifest_names: [...manifestNames],
    ...headerNameIsolationEvidence(Object.keys(request.headers), manifestNames)
  };
}

function responseHeaders(headers) {
  const selected = {};
  const connectionOwnedNames = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || RESPONSE_HEADER_DENYLIST.has(lower) || connectionOwnedNames.has(lower)) {
      continue;
    }
    selected[name] = value;
  }
  return selected;
}

function responseHeaderIsolationEvidence(headers, selectedHeaders) {
  return {
    ...headerNameIsolationEvidence(Object.keys(headers), Object.keys(selectedHeaders)),
    received_media_type: responseMediaType(headers["content-type"]),
    selected_media_type: responseMediaType(selectedHeaders["content-type"])
  };
}

function responseMediaType(value) {
  if (value === undefined) {
    return "missing";
  }
  if (Array.isArray(value)) {
    return "http_other";
  }
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  if (mediaType === "text/event-stream") {
    return "http_sse";
  }
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return "http_json";
  }
  return "http_other";
}

function upstreamUrl(requestUrl) {
  const incoming = new URL(requestUrl, "http://egress.invalid");
  const accountPath = ACCOUNT_READ_PATHS.get(incoming.pathname);
  if (accountPath !== undefined) {
    return new URL(accountPath, `${upstreamBaseUrl}/`);
  }
  return new URL(`${upstreamBaseUrl}${incoming.pathname}${incoming.search}`);
}

function sendEmpty(response, status) {
  response.writeHead(status, { "Content-Length": "0" });
  response.end();
}

function sendError(response, status, code) {
  const body = Buffer.from(JSON.stringify({
    error: {
      message: code,
      type: "invalid_request_error",
      code
    }
  }));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length)
  });
  response.end(body);
}

function waitForDrain(response) {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("downstream closed"));
    };
    const onError = () => {
      cleanup();
      reject(new Error("downstream write failed"));
    };
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

function forward(request, response, manifestNames, traceMetadata, outcomeSink) {
  const requestPath = new URL(request.url ?? "/", "http://egress.invalid").pathname;
  const target = upstreamUrl(request.url ?? "/");
  const transport = target.protocol === "https:" ? https : http;
  let responseStarted = false;
  const lifecycle = createTransportLifecycle({
    traceMetadata,
    method: request.method,
    path: requestPath,
    onFinish: (outcome) => {
      emitTransportEvent(outcomeSink, "egressOutcome", {
        event: egressProtocol.transportTrace.events.egressOutcome,
        schema_version: egressProtocol.transportTrace.schemaVersion,
        ...outcome
      });
    }
  });
  process.stderr.write(`${JSON.stringify({
    event: "header_isolation",
    method: request.method,
    path: target.pathname,
    ...headerIsolationEvidence(request, manifestNames)
  })}\n`);

  const upstreamRequest = transport.request(target, {
    method: request.method,
    headers: selectedRequestHeaders(request, manifestNames)
  });

  attachRequestRuntime({
    request,
    lifecycle,
    cancelUpstream: () => upstreamRequest.destroy()
  });
  attachDownstreamRuntime({
    response,
    lifecycle,
    cancelUpstream: () => upstreamRequest.destroy()
  });

  upstreamRequest.once("response", async (upstreamResponse) => {
    responseStarted = true;
    const status = upstreamResponse.statusCode ?? 502;
    lifecycle.recordUpstreamHeaders(status);
    const selectedResponseHeaders = responseHeaders(upstreamResponse.headers);
    process.stderr.write(`${JSON.stringify({
      event: "response_header_isolation",
      method: request.method,
      path: target.pathname,
      status,
      ...responseHeaderIsolationEvidence(upstreamResponse.headers, selectedResponseHeaders)
    })}\n`);
    try {
      response.writeHead(
        status,
        upstreamResponse.statusMessage,
        selectedResponseHeaders
      );
    } catch {
      lifecycle.finish("downstream_error");
      upstreamResponse.destroy();
      response.destroy();
      return;
    }
    try {
      for await (const chunk of upstreamResponse) {
        lifecycle.recordUpstreamRead(chunk.length);
        try {
          const needsDrain = !response.write(chunk, (error) => {
            if (error) {
              lifecycle.finish("downstream_error");
              upstreamResponse.destroy();
            }
          });
          lifecycle.recordDownstreamSubmit(chunk.length);
          if (needsDrain) {
            await waitForDrain(response);
          }
        } catch {
          lifecycle.finish("downstream_error");
          upstreamResponse.destroy();
          response.destroy();
          return;
        }
      }
      try {
        response.end(() => lifecycle.finish("completed"));
      } catch {
        lifecycle.finish("downstream_error");
        response.destroy();
      }
    } catch {
      lifecycle.finish("upstream_error");
      upstreamResponse.destroy();
      if (!response.writableEnded) {
        response.destroy();
      }
    }
  });

  upstreamRequest.once("error", () => {
    const outcome = lifecycle.finish("upstream_error");
    if (outcome.transport_outcome === egressProtocol.transportTrace.outcomes.upstreamRequestFailed) {
      if (!responseStarted && !response.headersSent && !response.destroyed) {
        sendEmpty(response, 502);
      }
    }
  });

  if (request.method === "GET") {
    request.resume();
    upstreamRequest.end();
  } else {
    request.pipe(upstreamRequest);
  }
}

function createRequestHandler(outcomeSink) {
  return (request, response) => {
    const parsed = new URL(request.url ?? "/", "http://egress.invalid");
    if (request.method === "GET" && parsed.pathname === "/healthz") {
      const body = Buffer.from("ok\n");
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(body.length)
      });
      response.end(body);
      return;
    }
    const allowed = (request.method === "GET" && parsed.pathname === "/models")
      || (request.method === "GET" && parsed.search === "" && ACCOUNT_READ_PATHS.has(parsed.pathname))
      || (request.method === "POST" && ALLOWED_POST_PATHS.has(parsed.pathname));
    if (!allowed) {
      sendEmpty(response, 404);
      return;
    }
    if (!hasValidSecret(request)) {
      sendError(response, 401, egressProtocol.errors.invalidSecret);
      return;
    }
    let manifestNames;
    try {
      manifestNames = parseManifest(request);
    } catch (error) {
      const code = error instanceof ManifestError ? error.code : egressProtocol.errors.invalidManifest;
      sendError(response, 400, code);
      return;
    }
    const traceMetadata = transportTraceMetadata(request);
    emitTransportEvent(outcomeSink, "egressAccepted", {
      event: egressProtocol.transportTrace.events.egressAccepted,
      schema_version: egressProtocol.transportTrace.schemaVersion,
      ...traceMetadata,
      method: request.method,
      path: parsed.pathname
    });
    forward(request, response, manifestNames, traceMetadata, outcomeSink);
  };
}

const server = http.createServer(createRequestHandler(transportOutcomeSink));

server.listen(port, bindHost, () => {
  process.stderr.write(`codex-egress-shim listening on ${bindHost}:${port}\n`);
});
