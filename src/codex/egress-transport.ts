import { HttpError } from "../errors";
import { assertCodexEgressBaseUrl } from "../proxy/origin";
import type { AppDependencies } from "../types";

/**
 * Codex egress transport.
 *
 * Exactly one transport is selected by `CODEX_EGRESS_TRANSPORT` and resolved before any
 * bearer, account id, egress secret or manifest is built. There is no fallback between
 * transports: a missing binding or unknown selector fails closed.
 *
 * - `vpc`: only the `CODEX_EGRESS` Workers VPC Service binding. The platform fixes the
 *   destination; the URL host only sets `Host`, so it is a reserved, non-public constant.
 * - `public`: the approved public tunnel origin through global fetch (rollback path).
 */
export const CODEX_EGRESS_VPC_ORIGIN = "http://codex-egress.internal";

export type CodexEgressTransportKind = "vpc" | "public";

export interface CodexEgressTransport {
  readonly kind: CodexEgressTransportKind;
  /** `pathAndSearch` is an adapter-owned egress path plus its already-projected query. */
  fetch(pathAndSearch: string, init: RequestInit): Promise<Response>;
}

type CodexEgressEnv = Pick<Env, "CODEX_EGRESS_TRANSPORT" | "CODEX_EGRESS_BASE_URL"> & {
  CODEX_EGRESS?: unknown;
};

export function codexEgressTransportKind(env: Pick<Env, "CODEX_EGRESS_TRANSPORT">): CodexEgressTransportKind {
  const selected = env.CODEX_EGRESS_TRANSPORT?.trim();
  if (selected === "vpc" || selected === "public") {
    return selected;
  }
  throw new HttpError(
    500,
    "CODEX_EGRESS_TRANSPORT must be vpc or public",
    "server_error",
    "invalid_codex_egress_transport"
  );
}

export function resolveCodexEgressTransport(env: CodexEgressEnv, deps: AppDependencies): CodexEgressTransport {
  if (codexEgressTransportKind(env) === "vpc") {
    const binding = codexEgressBinding(env);
    return {
      kind: "vpc",
      fetch: (pathAndSearch, init) => binding.fetch(`${CODEX_EGRESS_VPC_ORIGIN}${pathAndSearch}`, init)
    };
  }
  const baseUrl = assertCodexEgressBaseUrl(env.CODEX_EGRESS_BASE_URL);
  return {
    kind: "public",
    fetch: (pathAndSearch, init) => deps.fetch(`${baseUrl}${pathAndSearch}`, init)
  };
}

function codexEgressBinding(env: CodexEgressEnv): Pick<Fetcher, "fetch"> {
  const binding = env.CODEX_EGRESS as { fetch?: unknown } | null | undefined;
  if (!binding || typeof binding.fetch !== "function") {
    throw new HttpError(
      500,
      "CODEX_EGRESS binding is required for the vpc transport",
      "server_error",
      "missing_codex_egress_binding"
    );
  }
  return binding as Pick<Fetcher, "fetch">;
}

export interface CodexEgressReadiness {
  transport: CodexEgressTransportKind | null;
  status: "configured" | "invalid" | "missing";
}

/** Metadata-only readiness. Never performs a request and never exposes binding identity. */
export function codexEgressReadiness(env: CodexEgressEnv & Pick<Env, "CODEX_EGRESS_SECRET">): CodexEgressReadiness {
  let transport: CodexEgressTransportKind;
  try {
    transport = codexEgressTransportKind(env);
  } catch {
    return { transport: null, status: env.CODEX_EGRESS_TRANSPORT?.trim() ? "invalid" : "missing" };
  }
  try {
    resolveCodexEgressTransport(env, READINESS_DEPENDENCIES);
  } catch {
    const missing = transport === "vpc" || !env.CODEX_EGRESS_BASE_URL?.trim();
    return { transport, status: missing ? "missing" : "invalid" };
  }
  return { transport, status: env.CODEX_EGRESS_SECRET ? "configured" : "missing" };
}

const READINESS_DEPENDENCIES: AppDependencies = {
  fetch: () => Promise.reject(new Error("readiness never performs egress")),
  now: () => new Date()
};
