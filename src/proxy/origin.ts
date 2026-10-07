import { HttpError } from "../errors";
import { ProxyUpstreamError } from "./adapter";

export const CODEX_EGRESS_HOSTNAME = "codex-egress-us-west1-a.trustedtunnel.app";
export const CODEX_EGRESS_BASE_URL = `https://${CODEX_EGRESS_HOSTNAME}`;

/**
 * Strict HTTPS origin validation shared by NPE provider bases and Codex egress.
 * Rejects credentials-in-URL, non-root paths, query, and fragment.
 */
export function isStrictHttpsOrigin(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash
    );
  } catch {
    return false;
  }
}

export function assertStrictHttpsOrigin(
  value: string | undefined | null,
  options: {
    missingMessage: string;
    missingCode: string;
    invalidMessage: string;
    invalidCode: string;
    asProxyError?: boolean;
  }
): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    if (options.asProxyError) {
      throw new ProxyUpstreamError(500, options.missingMessage, options.missingCode, null, false);
    }
    throw new HttpError(500, options.missingMessage, "server_error", options.missingCode);
  }
  if (!isStrictHttpsOrigin(trimmed)) {
    if (options.asProxyError) {
      throw new ProxyUpstreamError(500, options.invalidMessage, options.invalidCode, null, false);
    }
    throw new HttpError(500, options.invalidMessage, "server_error", options.invalidCode);
  }
  return trimmed.replace(/\/+$/, "") || "https://invalid.invalid";
}

/** Codex egress base URL: fixed to the deployed shim before any credential is attached. */
export function assertCodexEgressBaseUrl(value: string | undefined | null): string {
  const normalized = assertStrictHttpsOrigin(value, {
    missingMessage: "CODEX_EGRESS_BASE_URL is required",
    missingCode: "missing_codex_egress_base_url",
    invalidMessage: "CODEX_EGRESS_BASE_URL must be the approved egress HTTPS origin",
    invalidCode: "invalid_codex_egress_base_url"
  });
  if (normalized !== CODEX_EGRESS_BASE_URL) {
    throw new HttpError(
      500,
      "CODEX_EGRESS_BASE_URL must be the approved egress HTTPS origin",
      "server_error",
      "invalid_codex_egress_base_url"
    );
  }
  return normalized;
}

export function assertProviderBaseUrl(value: string | undefined | null): string {
  return assertStrictHttpsOrigin(value, {
    missingMessage: "Provider base URL is required",
    missingCode: "missing_provider_base_url",
    invalidMessage: "Provider base URL is invalid",
    invalidCode: "invalid_provider_base_url",
    asProxyError: true
  });
}
