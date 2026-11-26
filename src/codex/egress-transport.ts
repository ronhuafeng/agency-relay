import { HttpError } from "../errors";

/**
 * Codex egress transport: the `CODEX_EGRESS` Workers VPC Service binding, and nothing else.
 *
 * The binding is resolved before any bearer, account id, egress secret or manifest is
 * built, and a missing binding fails closed. The platform fixes the destination; the URL
 * host only sets `Host`, so it is a reserved, non-public constant.
 */
export const CODEX_EGRESS_VPC_ORIGIN = "http://codex-egress.internal";

export interface CodexEgressTransport {
  /** `pathAndSearch` is an adapter-owned egress path plus its already-projected query. */
  fetch(pathAndSearch: string, init: RequestInit): Promise<Response>;
}

declare global {
  interface Env {
    /**
     * Workers VPC Service binding to the Codex egress shim. Production-only: the public
     * template declares none (local `wrangler dev` cannot emulate VPC Services), and
     * release control adds it from private settings.
     */
    CODEX_EGRESS?: Fetcher;
  }
}

type CodexEgressEnv = { CODEX_EGRESS?: unknown };

export function resolveCodexEgressTransport(env: CodexEgressEnv): CodexEgressTransport {
  const binding = env.CODEX_EGRESS as { fetch?: unknown } | null | undefined;
  if (!binding || typeof binding.fetch !== "function") {
    throw new HttpError(
      500,
      "CODEX_EGRESS binding is required",
      "server_error",
      "missing_codex_egress_binding"
    );
  }
  const egress = binding as Pick<Fetcher, "fetch">;
  return {
    fetch: (pathAndSearch, init) => egress.fetch(`${CODEX_EGRESS_VPC_ORIGIN}${pathAndSearch}`, init)
  };
}

/** Metadata-only readiness. Never performs a request and never exposes binding identity. */
export function codexEgressReadiness(
  env: CodexEgressEnv & Pick<Env, "CODEX_EGRESS_SECRET">
): "configured" | "missing" {
  try {
    resolveCodexEgressTransport(env);
  } catch {
    return "missing";
  }
  return env.CODEX_EGRESS_SECRET ? "configured" : "missing";
}
