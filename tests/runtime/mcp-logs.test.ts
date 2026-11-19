import {expect,it,vi} from "vitest";
import {logRuntimeMcp,mcpAuthorizationError,mcpDiscoveryMethod} from "../../src/runtime/mcp-logs";

it("emits fixed MCP fields and excludes caller-supplied strings and extra metadata",()=>{
  const log=vi.spyOn(console,"log").mockImplementation(()=>{});
  try {
    const fields={connector:"lark.doc" as const,stage:"authorization" as const,http_status:401,
      method:mcpDiscoveryMethod("synthetic-untrusted-method"),protocol_version:"synthetic-untrusted-version",
      error:mcpAuthorizationError("synthetic-untrusted-error"),url:"https://fake.example/path?code=synthetic"};
    logRuntimeMcp(fields);
    logRuntimeMcp({connector:"lark.doc",stage:"discovery",method:"tools/list",protocol_version:"2025-03-26",
      http_status:200,duration_ms:12,tool_count:0});
    expect(log.mock.calls.map(([event])=>JSON.parse(JSON.stringify(event)))).toEqual([
      {event:"runtime_mcp",connector:"lark.doc",stage:"authorization",protocol_version:"unknown",http_status:401,error:"authorization_rejected"},
      {event:"runtime_mcp",connector:"lark.doc",stage:"discovery",method:"tools/list",protocol_version:"2025-03-26",http_status:200,duration_ms:12,tool_count:0},
    ]);
  } finally {log.mockRestore();}
});
