import { request as httpsRequest } from "node:https";
import { expect } from "vitest";
import {
  assertNoSecret,
  isRecord,
  newestModel,
  parseJson,
  requireEnv,
  sleep
} from "./runtime";

const MODEL_ID = /^[A-Za-z0-9._~-]{1,200}$/;

export const HOST = {
  codex: "https://api.trustedtunnel.app",
  grok: "https://grok.trustedtunnel.app",
  xai: "https://xai.trustedtunnel.app"
} as const;

export interface LiveResponse {
  status: number;
  contentType: string;
  text: string;
  bytes: Buffer;
  headers: Headers;
}

export interface Price {
  id: string;
  input: number | null;
  output: number | null;
}

export function env(name: string): string {
  return requireEnv(name);
}

export async function call(
  url: string,
  apiKey: string | undefined,
  init: RequestInit = {},
  timeoutMs = 60_000
): Promise<LiveResponse> {
  const headers = new Headers(init.headers);
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  if (apiKey) {
    assertNoSecret(text, apiKey);
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text,
    bytes,
    headers: response.headers
  };
}

export function expectJson(response: LiveResponse, status = 200): unknown {
  expect(response.status).toBe(status);
  expect(response.contentType.toLowerCase()).toContain("application/json");
  return parseJson(response.text);
}

export function expectErrorCode(body: unknown, code: string): void {
  expect(isRecord(body) && isRecord(body.error) ? body.error.code : undefined).toBe(code);
}

export function assertModelId(id: string): void {
  expect(id).toMatch(MODEL_ID);
}

export function assertNotClosed(response: LiveResponse): void {
  if (response.status !== 404) {
    return;
  }
  let body: unknown;
  try {
    body = parseJson(response.text);
  } catch {
    return;
  }
  if (isRecord(body) && isRecord(body.error) && body.error.message === "Route not found") {
    throw new Error("mini path still closed");
  }
}

export async function standardPrices(): Promise<Price[]> {
  const response = await fetch("https://developers.openai.com/api/docs/pricing.md", {
    signal: AbortSignal.timeout(60_000)
  });
  expect(response.ok).toBe(true);
  const lines = (await response.text()).split("\n");
  let grab = false;
  let header = false;
  const prices: Price[] = [];
  for (const line of lines) {
    if (line === "### Standard pricing data") {
      grab = true;
      continue;
    }
    if (!grab) {
      continue;
    }
    if (line.startsWith("| Model |")) {
      header = true;
      continue;
    }
    if (header && line.startsWith("| ---")) {
      continue;
    }
    if (header && line.startsWith("| ")) {
      const cells = line.replace(/^\| /, "").replace(/ \|$/, "").split(" | ");
      if (cells.length >= 5) {
        const number = (value: string): number | null => {
          const cleaned = value.replaceAll("$", "");
          if (cleaned === "" || cleaned === "-") {
            return null;
          }
          const parsed = Number(cleaned);
          return Number.isFinite(parsed) ? parsed : null;
        };
        prices.push({
          id: (cells[0] ?? "").replace(/ \(.*\)$/, ""),
          input: number(cells[1] ?? ""),
          output: number(cells[4] ?? "")
        });
      }
      continue;
    }
    if (header) {
      break;
    }
  }
  expect(prices.length).toBeGreaterThan(0);
  return prices;
}

function matchingPrice(prices: Price[], id: string): Price | undefined {
  return prices.find((price) => price.id === id)
    ?? prices
      .filter((price) => id === price.id || id.startsWith(`${price.id}-`))
      .sort((left, right) => right.id.length - left.id.length)[0];
}

export function cheapestCodexModel(body: unknown, prices: Price[]): string {
  if (!isRecord(body) || !Array.isArray(body.models)) {
    throw new Error("catalog shape rejected");
  }
  let selected: { slug: string; score: number } | undefined;
  for (const model of body.models) {
    if (!isRecord(model) || typeof model.slug !== "string" || !MODEL_ID.test(model.slug)) {
      continue;
    }
    const visibility = typeof model.visibility === "string" ? model.visibility : "list";
    if (visibility !== "list" || /audio|realtime|transcribe|tts|whisper|image|dall|embedding|moderation/i.test(model.slug)) {
      continue;
    }
    const price = matchingPrice(prices, model.slug);
    if (!price || price.input === null || price.output === null) {
      continue;
    }
    const score = price.input + price.output;
    if (!selected || score < selected.score) {
      selected = { slug: model.slug, score };
    }
  }
  if (!selected) {
    throw new Error("catalog model missing");
  }
  return selected.slug;
}

export async function codexLanguageModel(apiKey: string): Promise<string> {
  const response = await call(`${HOST.codex}/v1/models`, apiKey);
  expect(response.status).toBe(200);
  expect(response.contentType.toLowerCase()).toContain("application/json");
  expect(response.headers.get("etag")).toBeTruthy();
  const id = cheapestCodexModel(parseJson(response.text), await standardPrices());
  assertModelId(id);
  return id;
}

export async function catalogModel(origin: string, apiKey: string, path: string, reject: RegExp): Promise<string> {
  const response = await call(`${origin}${path}`, apiKey);
  const id = newestModel(expectJson(response), reject);
  assertModelId(id);
  expectJson(await call(`${origin}${path}/${encodeURIComponent(id)}`, apiKey));
  return id;
}

export function firstVoice(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.voices) || !isRecord(body.voices[0]) || typeof body.voices[0].voice_id !== "string") {
    throw new Error("voice catalog rejected");
  }
  const id = body.voices[0].voice_id;
  assertModelId(id);
  return id;
}

export async function voiceId(origin: string, apiKey: string): Promise<string> {
  const response = await call(`${origin}/v1/tts/voices`, apiKey);
  const id = firstVoice(expectJson(response));
  expectJson(await call(`${origin}/v1/tts/voices/${encodeURIComponent(id)}`, apiKey));
  return id;
}

export function firstDataId(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.data) || !isRecord(body.data[0]) || typeof body.data[0].id !== "string") {
    throw new Error("catalog model missing");
  }
  const id = body.data[0].id;
  assertModelId(id);
  return id;
}

export function grokGatewayModel(body: unknown): string {
  const rows = isRecord(body) && Array.isArray(body.data)
    ? body.data
    : isRecord(body) && Array.isArray(body.models)
      ? body.models
      : [];
  const ids = rows.flatMap((row) => {
    const id = typeof row === "string" ? row : isRecord(row) && typeof row.id === "string" ? row.id : "";
    return MODEL_ID.test(id) ? [id] : [];
  });
  const selected = ids.find((id) => !/fast|voice|imagine|image|video|latest/i.test(id)) ?? ids[0];
  if (!selected) {
    throw new Error("catalog model missing");
  }
  return selected;
}

export function realtimeCallBody(session: unknown): string {
  return [
    "--codex-realtime-call-boundary",
    "Content-Disposition: form-data; name=\"sdp\"",
    "Content-Type: application/sdp",
    "",
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "",
    "--codex-realtime-call-boundary",
    "Content-Disposition: form-data; name=\"session\"",
    "Content-Type: application/json",
    "",
    JSON.stringify(session),
    "--codex-realtime-call-boundary--",
    ""
  ].join("\r\n");
}

export function bytesToHex(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let hex = "";
  for (const byte of bytes.subarray(start, end)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function bytesToAscii(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let text = "";
  for (const byte of bytes.subarray(start, end)) {
    text += String.fromCharCode(byte);
  }
  return text;
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function imageType(bytes: Buffer): string {
  expect(bytes.length).toBeGreaterThanOrEqual(32);
  const signature = bytesToHex(bytes, 0, 12);
  if (signature.startsWith("ffd8ff")) {
    return "image/jpeg";
  }
  if (signature.startsWith("89504e470d0a1a0a")) {
    return "image/png";
  }
  if (signature.startsWith("52494646") && signature.slice(16, 24) === "57454250") {
    return "image/webp";
  }
  throw new Error("image magic rejected");
}

export function assertImage(bytes: Buffer): void {
  imageType(bytes);
}

export function assertVideo(bytes: Buffer): void {
  expect(bytes.length).toBeGreaterThanOrEqual(32);
  expect(bytesToAscii(bytes, 4, 8)).toBe("ftyp");
}

export function wavProbe(): Buffer {
  const data = Buffer.alloc(800 * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function upgrade(
  url: string,
  apiKey: string,
  extra: Record<string, string> = {},
  timeoutMs = 20_000
): Promise<LiveResponse> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      method: "GET",
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...extra
      },
      timeout: timeoutMs
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString("utf8");
        assertNoSecret(text, apiKey);
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          text,
          bytes,
          headers: headersFrom(res.headers)
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}

export async function optionalUpgrade(url: string, apiKey: string, extra: Record<string, string> = {}): Promise<void> {
  try {
    assertNotClosed(await upgrade(url, apiKey, extra));
  } catch (error) {
    if (error instanceof Error && error.message === "mini path still closed") {
      throw error;
    }
  }
}

export async function pollVideo(origin: string, apiKey: string, jobId: string): Promise<unknown> {
  const deadline = Date.now() + 1_800_000;
  while (Date.now() < deadline) {
    const response = await call(`${origin}/v1/videos/${jobId}`, apiKey);
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    const body = parseJson(response.text);
    const state = isRecord(body) && typeof body.status === "string"
      ? body.status
      : response.status === 202
        ? "pending"
        : "";
    if (state === "done") {
      return body;
    }
    expect(state).toBe("pending");
    await sleep(15_000);
  }
  throw new Error("terminal not reached");
}

export async function generatedImage(response: LiveResponse): Promise<Buffer> {
  const body = expectJson(response);
  expect(isRecord(body) && Array.isArray(body.data) && body.data.length === 1).toBe(true);
  const row = isRecord(body) && Array.isArray(body.data) ? body.data[0] : undefined;
  if (!isRecord(row) || typeof row.b64_json !== "string") {
    throw new Error("image payload rejected");
  }
  const bytes = Buffer.from(row.b64_json, "base64");
  assertImage(bytes);
  return bytes;
}

function headersFrom(source: NodeJS.Dict<string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      headers.set(name, value.join(", "));
    }
  }
  return headers;
}

export { isRecord, parseJson };
