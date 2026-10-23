import { bytesToHex } from "../crypto";
import { errorResponse } from "../errors";
import type { AuthenticatedUser } from "../types";

export type RoutePolicyReason =
  | "method_not_allowed"
  | "path_not_allowed"
  | "query_credential_not_allowed";

const SAFE_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/;
const MAX_LOGGED_PATH_BYTES = 256;

/**
 * A3: single Mini-owned error exit for plan failures.
 * Client envelope stays OpenAI-compatible.
 */
export function renderPlanError(error: unknown, requestId: string): Response {
  return errorResponse(error, requestId);
}

export async function routeProfilePolicyRejection(
  request: Request,
  auth: AuthenticatedUser,
  profile: { id: string },
  reason: RoutePolicyReason,
  status: 400 | 404 | 405,
  allow?: string
): Promise<Response> {
  const traceId = crypto.randomUUID();
  const url = new URL(request.url);
  const pathnameBytes = new TextEncoder().encode(url.pathname);
  const event: Record<string, unknown> = {
    event: "route_policy_rejection",
    route_policy_trace_id: traceId,
    route_profile_id: profile.id,
    reason,
    method: request.method,
    pathname_sha256: await sha256Hex(pathnameBytes),
    pathname_bytes: pathnameBytes.byteLength,
    query_present: url.search.length > 0,
    user_id: auth.user.id,
    key_id: auth.apiKey.id
  };
  if (pathnameBytes.byteLength <= MAX_LOGGED_PATH_BYTES && SAFE_PATH.test(url.pathname)) {
    event.pathname = url.pathname;
  }
  console.log(JSON.stringify(event));

  const headers = {
    ...(allow ? { Allow: allow } : {}),
    "X-Mini-Route-Policy-Trace-Id": traceId
  };
  const mapped = openAIPolicyError(reason);
  return openAIErrorResponse(status, mapped.type, mapped.message, mapped.code, traceId, headers);
}

export function hasReservedCredentialQuery(url: URL): boolean {
  const reserved = new Set(["key", "api_key", "access_token", "token", "authorization"]);
  for (const name of url.searchParams.keys()) {
    if (reserved.has(name.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function openAIPolicyError(reason: RoutePolicyReason): { type: string; code: string; message: string } {
  if (reason === "path_not_allowed") {
    return { type: "invalid_request_error", code: "not_found", message: "The requested route was not found." };
  }
  if (reason === "method_not_allowed") {
    return {
      type: "invalid_request_error",
      code: "method_not_allowed",
      message: "The request method is not allowed for this route."
    };
  }
  return {
    type: "invalid_request_error",
    code: "query_credential_not_allowed",
    message: "Credentials are not accepted in the query string."
  };
}

function openAIErrorResponse(
  status: number,
  type: string,
  message: string,
  code: string,
  requestId: string,
  extraHeaders: HeadersInit = {}
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json");
  headers.set("x-request-id", requestId);
  return new Response(JSON.stringify({
    error: {
      message,
      type,
      param: null,
      code
    }
  }), { status, headers });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return bytesToHex(new Uint8Array(digest));
}
