import { expect, it } from "vitest";
import { admin, expectTerminal, isRecord, languageModel, parseJson, send } from "./runtime";

it("admits Codex and Grok surface credits independently", async () => {
  const accounts = await activeAccounts();
  const created = await admin("POST", "/admin/users", {});
  expect(created.status).toBe(201);
  expect(created.json).toMatchObject({ user: { id: expect.any(String) } });
  const userId = (created.json as { user: { id: string } }).user.id;
  const keyIds: string[] = [];
  try {
    const first = await issue(userId, ["surface:codex:production"], [{ surface_grant: "surface:codex:production", credential_account_id: accounts.codex }]);
    const second = await issue(userId, ["surface:codex:production", "surface:grok:production"], [
      { surface_grant: "surface:codex:production", credential_account_id: accounts.codex },
      { surface_grant: "surface:grok:production", credential_account_id: accounts.grok }
    ]);
    keyIds.push(first.id, second.id);
    await admin("PUT", `/admin/users/${userId}/credits/codex`, { monthly_allowance: 1 });
    await admin("PUT", `/admin/users/${userId}/credits/grok`, { monthly_allowance: 1 });
    const codexModel = await codexModelId(first.token);
    expectTerminal(await send("https://api.trustedtunnel.app/v1/responses", first.token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: codexModel, input: "Reply exactly OK.", stream: false })
    }, 180_000));
    const denied = await send("https://api.trustedtunnel.app/v1/responses", second.token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: codexModel, input: "Reply exactly OK.", stream: false })
    }, 60_000);
    expect(denied.status).toBe(429);
    expect(parseJson(denied.text)).toMatchObject({ error: { code: "surface_credit_exhausted" } });
    const grokModel = await languageModel("https://grok.trustedtunnel.app", second.token);
    expectTerminal(await send("https://grok.trustedtunnel.app/v1/responses", second.token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: grokModel, input: "Reply exactly OK.", stream: false })
    }, 180_000));
    const credits = await admin("GET", `/admin/users/${userId}/credits`);
    expect(credits.status).toBe(200);
    expect(credits.json).toEqual(expect.objectContaining({
      states: expect.arrayContaining([
        expect.objectContaining({ surface_grant: "surface:codex:production", consumed_credits: 1, remaining_credits: 0 }),
        expect.objectContaining({ surface_grant: "surface:grok:production", consumed_credits: 1, remaining_credits: 0 })
      ])
    }));
  } finally {
    for (const keyId of keyIds) {
      await admin("DELETE", `/admin/keys/${keyId}`);
    }
    await admin("DELETE", `/admin/users/${userId}/credits/codex`);
    await admin("DELETE", `/admin/users/${userId}/credits/grok`);
  }
}, 600_000);

async function activeAccounts(): Promise<{ codex: string; grok: string }> {
  const codex = await admin("GET", "/admin/codex-auths");
  const grok = await admin("GET", "/admin/subscriptions");
  expect(codex.status).toBe(200);
  expect(grok.status).toBe(200);
  expect(codex.json).toEqual(expect.objectContaining({ auths: expect.any(Array) }));
  expect(grok.json).toEqual(expect.objectContaining({ accounts: expect.any(Array) }));
  const codexAccount = isRecord(codex.json) && Array.isArray(codex.json.auths)
    ? codex.json.auths.filter(isRecord).find((row) => row.status === "active")
    : undefined;
  const grokAccount = isRecord(grok.json) && Array.isArray(grok.json.accounts)
    ? grok.json.accounts.filter(isRecord).find((row) => row.capability_source === "grok" && row.environment === "production" && row.status === "active")
    : undefined;
  expect(codexAccount).toEqual(expect.objectContaining({ id: expect.any(String) }));
  expect(grokAccount).toEqual(expect.objectContaining({ id: expect.any(String) }));
  return { codex: (codexAccount as { id: string }).id, grok: (grokAccount as { id: string }).id };
}

async function issue(userId: string, scopes: string[], bindings: Array<{ surface_grant: string; credential_account_id: string }>): Promise<{ id: string; token: string }> {
  const issued = await admin("POST", `/admin/users/${userId}/keys`, { name: "Live key", scopes, credential_bindings: bindings });
  expect(issued.status).toBe(201);
  expect(issued.json).toMatchObject({ key: { id: expect.any(String) }, api_key: expect.any(String) });
  const body = issued.json as { key: { id: string }; api_key: string };
  return { id: body.key.id, token: body.api_key };
}

async function codexModelId(key: string): Promise<string> {
  const catalog = await send("https://api.trustedtunnel.app/v1/models", key);
  expect(catalog.status).toBe(200);
  const body = parseJson(catalog.text);
  expect(body).toEqual(expect.objectContaining({ models: expect.any(Array) }));
  const slug = isRecord(body) && Array.isArray(body.models)
    ? body.models.filter(isRecord).map((model) => model.slug).find((id) => typeof id === "string" && !/audio|realtime|transcribe|tts|whisper|image|embedding|moderation/i.test(id))
    : undefined;
  expect(slug).toEqual(expect.any(String));
  return slug as string;
}
