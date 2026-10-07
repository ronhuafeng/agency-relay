export const PRODUCT_ACCESS = {
  codex: {
    id: "codex",
    label: "Codex",
    grant: "surface:codex:production"
  },
  grok: {
    id: "grok",
    label: "Grok",
    grant: "surface:grok:production"
  },
  xai: {
    id: "xai",
    label: "xAI API",
    grant: "surface:xai:production"
  }
} as const;

export type ProductAccessId = keyof typeof PRODUCT_ACCESS;
export type ClientSetupId = "codex" | "grok" | "xai";

export interface ClientSetupFile {
  client: ClientSetupId;
  clientLabel: string;
  filename: string;
  installTarget: string;
  content: string;
}

export const CLIENT_SETUP_TOKEN_PLACEHOLDER = "__MINI_END_USER_KEY__";

const CODEX_BASE_URL = "https://api.trustedtunnel.app/v1";
const GROK_BASE_URL = "https://grok.trustedtunnel.app/v1";
const XAI_BASE_URL = "https://xai.trustedtunnel.app/v1";

const CODEX_HEADER = `# Agency Relay Codex CLI 安装
# 地址：${CODEX_BASE_URL}
# 密钥只在这个文件里。不要分享。
# 如果不能使用：请管理员在控制台「账号」检查 ChatGPT 连接。
`;

const GROK_HEADER = `# Agency Relay Grok Build 安装
# 地址：${GROK_BASE_URL}
# 密钥只在这个文件里。不要分享。
# 如果不能使用：请管理员在控制台「账号」检查 Grok 连接。
`;

const XAI_HEADER = `# Agency Relay xAI API 安装
# 这是环境变量片段，不是可执行脚本。
# 把 XAI_BASE_URL 填到客户端的接口地址。客户端不会自动读取这个变量。
# 密钥只在这个文件里。不要分享。
# 如果不能使用：请管理员在控制台「账号」检查 Grok 连接。
`;

export function productAccessFromScopes(scopes: readonly string[]): Record<ProductAccessId, boolean> {
  const granted = new Set(scopes);
  return {
    codex: granted.has(PRODUCT_ACCESS.codex.grant),
    grok: granted.has(PRODUCT_ACCESS.grok.grant),
    xai: granted.has(PRODUCT_ACCESS.xai.grant)
  };
}

export function productAccessLabels(scopes: readonly string[]): string[] {
  const access = productAccessFromScopes(scopes);
  return (Object.keys(PRODUCT_ACCESS) as ProductAccessId[])
    .filter((id) => access[id])
    .map((id) => PRODUCT_ACCESS[id].label);
}

/**
 * Server-side setup files exist only while newly issued plaintext is available.
 * Browser-local templates can also use a key the user already holds; Agency Relay stores
 * only a keyed hash and cannot recover the old plaintext.
 */
export function buildClientSetupFiles(input: {
  token: string;
  scopes: readonly string[];
}): ClientSetupFile[] {
  const access = productAccessFromScopes(input.scopes);
  const token = tomlString(input.token);
  const files: ClientSetupFile[] = [];

  if (access.codex) {
    files.push({
      client: "codex",
      clientLabel: "Codex CLI",
      filename: "codex-config.toml",
      installTarget: "~/.codex/config.toml",
      content: `${CODEX_HEADER}
model = "gpt-5.6-sol"
model_provider = "mini_codex"

[model_providers.mini_codex]
name = "Agency Relay Codex"
base_url = "${CODEX_BASE_URL}"
wire_api = "responses"
experimental_bearer_token = ${token}
`
    });
  }

  if (access.grok) {
    files.push({
      client: "grok",
      clientLabel: "Grok Build",
      filename: "grok-config.toml",
      installTarget: "~/.grok/config.toml",
      content: `${GROK_HEADER}
[endpoints]
xai_api_base_url = "${GROK_BASE_URL}"

[models]
default = "mini-grok-4-6"

[model.mini-grok-4-6]
model = "grok-4.6"
base_url = "${GROK_BASE_URL}"
name = "Agency Relay Grok 4.6"
description = "通过 Agency Relay 使用 Grok"
api_backend = "responses"
api_key = ${token}
`
    });
  }

  if (access.xai) {
    files.push({
      client: "xai",
      clientLabel: "xAI API",
      filename: "xai-api.env",
      installTarget: "项目环境。在客户端中填写接口地址。",
      content: `${XAI_HEADER}
XAI_BASE_URL=${tomlString(XAI_BASE_URL)}
XAI_API_KEY=${token}
`
    });
  }

  return files;
}

export function buildClientSetupTemplates(): ClientSetupFile[] {
  return buildClientSetupFiles({
    token: CLIENT_SETUP_TOKEN_PLACEHOLDER,
    scopes: Object.values(PRODUCT_ACCESS).map((access) => access.grant)
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
