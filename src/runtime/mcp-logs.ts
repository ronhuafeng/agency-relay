import type {RuntimeProfileId} from "./profiles";
import type {RuntimeTransportError} from "./oauth";

const versions = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"]);
const authorizationErrors = ["invalid_token", "insufficient_scope", "access_denied", "runtime_capacity_exceeded", "temporarily_unavailable"] as const;
type AuthorizationError = typeof authorizationErrors[number];
type DiscoveryMethod = "initialize" | "tools/list";

export function mcpDiscoveryMethod(value: unknown): DiscoveryMethod | undefined {
  return value === "initialize" || value === "tools/list" ? value : undefined;
}

export function mcpAuthorizationError(value: unknown): AuthorizationError | "authorization_rejected" {
  return authorizationErrors.find(error => error === value) ?? "authorization_rejected";
}

export function logRuntimeMcp(fields: {
  connector: RuntimeProfileId;
  stage: "protocol" | "authorization" | "discovery";
  method?: DiscoveryMethod;
  protocol_version?: unknown;
  http_status: number;
  error?: RuntimeTransportError | AuthorizationError | "authorization_rejected";
  duration_ms?: number;
  tool_count?: number;
}) {
  const {connector,stage,method,protocol_version,http_status,error,duration_ms,tool_count} = fields;
  const version = typeof protocol_version === "string" && versions.has(protocol_version) ? protocol_version : "unknown";
  // Only fixed metadata is emitted. Protocol values supplied by peers must pass the allowlist.
  console.log({event:"runtime_mcp",connector,stage,method,protocol_version:version,http_status,error,duration_ms,tool_count});
}
