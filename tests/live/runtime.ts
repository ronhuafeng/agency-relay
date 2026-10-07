import { expect } from "vitest";

const MODEL_ID = /^[A-Za-z0-9._~-]{1,200}$/;

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is missing`);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertNoSecret(text: string, secret: string): void {
  if (text.includes(secret)) {
    throw new Error("caller key returned");
  }
}


export async function send(
  url: string,
  key: string,
  init: RequestInit = {},
  timeoutMs = 60_000
): Promise<{ status: number; contentType: string; text: string }> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  assertNoSecret(text, key);
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text
  };
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("json rejected");
  }
}

export function newestModel(body: unknown, reject: RegExp): string {
  if (!isRecord(body) || !Array.isArray(body.models)) {
    throw new Error("catalog shape rejected");
  }
  const models = body.models.filter(isRecord).flatMap((model) => {
    const id = model.id;
    if (typeof id !== "string" || !MODEL_ID.test(id) || id === "latest" || /latest$/i.test(id) || reject.test(id)) {
      return [];
    }
    const created = typeof model.created === "number" && Number.isFinite(model.created) ? model.created : 0;
    return [{ id, created }];
  });
  const selected = models.sort((left, right) => right.created - left.created || left.id.localeCompare(right.id))[0];
  if (!selected) {
    throw new Error("catalog model missing");
  }
  return selected.id;
}

export async function admin(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: unknown }> {
  const secret = requireEnv("MINI_ADMIN_SECRET");
  const response = await fetch(`https://api.trustedtunnel.app${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000)
  });
  const text = await response.text();
  assertNoSecret(text, secret);
  return { status: response.status, json: text.length === 0 ? null : parseJson(text) };
}

export async function languageModel(origin: string, key: string): Promise<string> {
  const catalog = await send(`${origin}/v1/language-models`, key);
  expect(catalog.status).toBe(200);
  expect(catalog.contentType.toLowerCase()).toContain("application/json");
  return newestModel(parseJson(catalog.text), /voice|imagine|embedding/i);
}

export function expectTerminal(response: { status: number; contentType: string; text: string }): void {
  expect(response.status).toBe(200);
  expect(response.contentType.toLowerCase()).toContain("application/json");
  expect(parseJson(response.text)).toMatchObject({
    status: expect.stringMatching(/^(completed|incomplete|failed|cancelled|canceled)$/)
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
