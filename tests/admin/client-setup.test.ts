import { describe, expect, it } from "vitest";
import {
  buildClientSetupTemplates,
  buildClientSetupFiles,
  CLIENT_SETUP_TOKEN_PLACEHOLDER,
  productAccessFromScopes,
  productAccessLabels
} from "../../src/admin/client-setup";

describe("client setup projection", () => {
  it("projects human product access without exposing grant syntax", () => {
    const scopes = [
      "surface:codex:production",
      "surface:unknown:production"
    ];
    expect(productAccessFromScopes(scopes)).toEqual({
      codex: true,
      grok: false,
      xai: false
    });
    expect(productAccessLabels(scopes)).toEqual(["Codex"]);
  });

  it("builds only the client files authorized by the new key", () => {
    const files = buildClientSetupFiles({
      token: "cfwd_example",
      scopes: [
        "surface:codex:production",
        "surface:grok:production",
        "surface:xai:production",
        "surface:unknown:production"
      ]
    });

    expect(files.map((file) => file.client)).toEqual(["codex", "grok", "xai"]);
    expect(files.find((file) => file.client === "codex")?.content).toContain(
      'model = "gpt-6.1-sol"'
    );
    expect(files.find((file) => file.client === "codex")?.content).toContain(
      'base_url = "https://api.trustedtunnel.app/v1"'
    );
    // Accounts are administrator-owned; member setup must not imply permission
    // to reconnect provider credentials (experience.md: Administrator Accounts).
    expect(files.find((file) => file.client === "codex")?.content).toContain("请管理员在控制台「账号」检查 ChatGPT 连接");
    const grokConfig = files.find((file) => file.client === "grok")?.content;
    expect(grokConfig).toContain(
      'base_url = "https://grok.trustedtunnel.app/v1"'
    );
    expect(grokConfig).toContain(
      '[endpoints]\nxai_api_base_url = "https://grok.trustedtunnel.app/v1"'
    );
    expect(grokConfig).toContain('default = "mini-grok-4-7"');
    expect(grokConfig).toContain('[model.mini-grok-4-7]\nmodel = "grok-4.7"');
    expect(grokConfig).toContain('name = "Agency Relay Grok 4.7"');
    expect(grokConfig).not.toContain("grok-4.6");
    expect(grokConfig).toContain("请管理员在控制台「账号」检查 Grok 连接");
    const xaiEnv = files.find((file) => file.client === "xai")?.content;
    expect(xaiEnv).toContain('XAI_API_KEY="cfwd_example"');
    expect(xaiEnv).toContain("xAI 使用这个 Grok 上游账号，不是单独的 xAI 凭据。");
    expect(xaiEnv).toContain('XAI_BASE_URL="https://xai.trustedtunnel.app/v1"');
    expect(files.find((file) => file.client === "xai")?.installTarget).toContain(
      "项目环境。在客户端中填写接口地址。"
    );
    for (const file of files) {
      expect(file.content).toContain("cfwd_example");
      expect(file.content).not.toContain("surface:");
    }
  });

  it("accepts a current catalog model without changing the service address", () => {
    const files = buildClientSetupFiles({
      token: "cfwd_example",
      scopes: ["surface:codex:production", "surface:grok:production"],
      models: { codex: "gpt-5.6-sol", grok: "grok-4.6" }
    });
    expect(files.find((file) => file.client === "codex")?.content).toContain('model = "gpt-5.6-sol"');
    expect(files.find((file) => file.client === "codex")?.content).toContain('base_url = "https://api.trustedtunnel.app/v1"');
    expect(files.find((file) => file.client === "grok")?.content).toContain('model = "grok-4.6"');
    expect(files.find((file) => file.client === "grok")?.content).toContain('base_url = "https://grok.trustedtunnel.app/v1"');
    expect(() => buildClientSetupFiles({
      token: "cfwd_example",
      scopes: ["surface:codex:production"],
      models: { codex: "gpt-5.6-sol\nmodel_provider" }
    })).toThrow("Invalid client setup model");
  });

  it("does not invent setup files for ungranted clients", () => {
    const files = buildClientSetupFiles({
      token: "cfwd_grok_only",
      scopes: ["surface:grok:production"]
    });
    expect(files.map((file) => file.client)).toEqual(["grok"]);
  });

  it("provides local-only templates without a real credential", () => {
    const templates = buildClientSetupTemplates();
    expect(templates).toHaveLength(3);
    expect(templates.every((file) => file.content.includes(CLIENT_SETUP_TOKEN_PLACEHOLDER))).toBe(true);
    expect(JSON.stringify(templates)).not.toContain("cfwd_");
  });
});
