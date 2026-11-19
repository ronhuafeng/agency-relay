import type {RuntimeProfileId} from "./profiles";
import type {RuntimeTransportError} from "./oauth";

const versions = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"]);
const authorizationErrors = ["invalid_token", "insufficient_scope", "access_denied", "runtime_capacity_exceeded", "temporarily_unavailable"] as const;
type AuthorizationError = typeof authorizationErrors[number];
type DiscoveryMethod = "initialize" | "tools/list";
type ToolOutcome = "result" | "tool_error" | "rpc_error";

export function mcpDiscoveryMethod(value: unknown): DiscoveryMethod | undefined {
  return value === "initialize" || value === "tools/list" ? value : undefined;
}

export function mcpAuthorizationError(value: unknown): AuthorizationError | "authorization_rejected" {
  return authorizationErrors.find(error => error === value) ?? "authorization_rejected";
}

export function logRuntimeMcp(fields: {
  connector: RuntimeProfileId;
  stage: "protocol" | "authorization" | "discovery" | "call";
  method?: DiscoveryMethod | "tools/call";
  protocol_version?: unknown;
  http_status: number;
  error?: RuntimeTransportError | AuthorizationError | "authorization_rejected";
  duration_ms?: number;
  tool_count?: number;
  tool?: string;
  terminal?: "completed" | "cancelled" | "error";
  request_bytes?: number;
  response_bytes?: number;
  headers_ms?: number;
  uat_http_status?: number;
  tat_http_status?: number;
  eligible_uat_tools?: number;
  eligible_tat_tools?: number;
  has_next_page?: boolean;
  rpc_outcome?: ToolOutcome;
}) {
  const {connector,stage,method,protocol_version,http_status,error,duration_ms,tool_count,tool,terminal,
    request_bytes,response_bytes,headers_ms,uat_http_status,tat_http_status,eligible_uat_tools,eligible_tat_tools,
    has_next_page,rpc_outcome} = fields;
  const version = typeof protocol_version === "string" && versions.has(protocol_version) ? protocol_version : "unknown";
  // Only fixed metadata is emitted. Protocol values supplied by peers must pass the allowlist.
  console.log({event:"runtime_mcp",connector,stage,method,protocol_version:version,http_status,error,duration_ms,tool_count,
    tool,terminal,request_bytes,response_bytes,headers_ms,uat_http_status,tat_http_status,eligible_uat_tools,eligible_tat_tools,
    has_next_page,rpc_outcome});
}
