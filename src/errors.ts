import type { ErrorBody } from "./types";

export class HttpError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code?: string;
  readonly headers?: Headers;
  readonly body?: unknown;

  constructor(status: number, message: string, type = "invalid_request_error", code?: string, options: { headers?: Headers; body?: unknown } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.type = type;
    this.code = code;
    this.headers = options.headers;
    this.body = options.body;
  }
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(error: unknown, requestId?: string): Response {
  const httpError = normalizeError(error);
  const rid = requestId ?? crypto.randomUUID();
  const headers = new Headers(httpError.headers);
  if (!headers.has("x-request-id")) {
    headers.set("x-request-id", rid);
  }
  if (httpError.body !== undefined) {
    return jsonResponse(httpError.body, { status: httpError.status, headers });
  }
  const body: ErrorBody = {
    error: {
      message: httpError.message,
      type: httpError.type,
      code: httpError.code,
      request_id: rid
    }
  };
  return jsonResponse(body, { status: httpError.status, headers });
}

const PUBLIC_INTERNAL_MESSAGE = "An internal error occurred";
const PUBLIC_INTERNAL_CODE = "internal_error";

/**
 * Map unknown failures to a stable public HttpError.
 * Raw exception strings, stack traces, and configuration details stay out of client bodies.
 */
export function normalizeError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof Error) {
    console.error(JSON.stringify({
      event: "internal_error_redacted",
      error_name: error.name,
      // message logged server-side only; never returned to clients for unknown failures
      error_message: error.message.slice(0, 500)
    }));
    return new HttpError(500, PUBLIC_INTERNAL_MESSAGE, "server_error", PUBLIC_INTERNAL_CODE);
  }
  console.error(JSON.stringify({
    event: "internal_error_redacted",
    error_name: "unknown"
  }));
  return new HttpError(500, PUBLIC_INTERNAL_MESSAGE, "server_error", PUBLIC_INTERNAL_CODE);
}
