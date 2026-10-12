import { expect, it } from "vitest";
import { assertCompletedSse } from "./oracles";
import { withCreditCleanup, type OwnedCreditKey } from "./credit-cleanup";
import { admin, assertJsonShape, expectTerminal, isRecord, languageModel, parseJson, send } from "./runtime";

it("admits Codex and Grok surface credits independently", async () => {
  const accounts = await activeAccounts();
  const displayName = `Live Credits ${process.env.GITHUB_RUN_ID ?? "manual"}`;
  const created = await admin("POST", "/admin/services", { display_name: displayName });
  expect(created.status).toBe(201);
  assertJsonShape(created.json, { user: { id: expect.any(String), account_kind: "service", display_name: displayName } });
  const userId = (created.json as { user: { id: string } }).user.id;
  const keys: OwnedCreditKey[] = [];
  await withCreditCleanup(userId, keys, async () => {
    for (const surface of ["codex", "grok"]) {
      const credited = await admin("PUT", `/admin/users/${userId}/credits/${surface}`, { monthly_allowance: 1 });
      expect(credited.status).toBe(200);
    }
    const first = await issue(userId, ["surface:codex:production"], [{ surface_grant: "surface:codex:production", credential_account_id: accounts.codex }], keys);
    const second = await issue(userId, ["surface:codex:production", "surface:grok:production"], [
      { surface_grant: "surface:codex:production", credential_account_id: accounts.codex },
      { surface_grant: "surface:grok:production", credential_account_id: accounts.grok }
    ], keys);
    const codexModel = await codexModelId(first.token);
    const codexBody = JSON.stringify({
      model: codexModel,
      instructions: "Reply concisely.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply exactly OK." }] }],
      store: false,
      stream: true
    });
    const admitted = await send("https://api.trustedtunnel.app/v1/responses", first.token, {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: codexBody
    }, 180_000);
    expect(admitted.status).toBe(200);
    expect(admitted.contentType.toLowerCase()).toContain("text/event-stream");
    assertCompletedSse(admitted.text);
    const denied = await send("https://api.trustedtunnel.app/v1/responses", second.token, {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: codexBody
    }, 60_000);
    expect(denied.status).toBe(429);
    assertJsonShape(parseJson(denied.text), { error: { code: "surface_credit_exhausted" } });
    const grokModel = await languageModel("https://grok.trustedtunnel.app", second.token);
    expectTerminal(await send("https://grok.trustedtunnel.app/v1/responses", second.token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: grokModel, input: "Reply exactly OK.", stream: false })
    }, 180_000));
    const credits = await admin("GET", `/admin/users/${userId}/credits`);
    expect(credits.status).toBe(200);
    assertJsonShape(credits.json, {
      states: expect.arrayContaining([
        expect.objectContaining({ surface_grant: "surface:codex:production", consumed_credits: 1, remaining_credits: 0 }),
        expect.objectContaining({ surface_grant: "surface:grok:production", consumed_credits: 1, remaining_credits: 0 })
      ])
    });
  });
}, 600_000);

async function activeAccounts(): Promise<{ codex: string; grok: string }> {
  const codex = await admin("GET", "/admin/codex-auths");
  const grok = await admin("GET", "/admin/subscriptions");
  expect(codex.status).toBe(200);
  expect(grok.status).toBe(200);
  assertJsonShape(codex.json, { auths: expect.any(Array) });
  assertJsonShape(grok.json, { accounts: expect.any(Array) });
  const codexAccount = isRecord(codex.json) && Array.isArray(codex.json.auths)
    ? codex.json.auths.filter(isRecord).find((row) => row.status === "active")
    : undefined;
  const grokAccount = isRecord(grok.json) && Array.isArray(grok.json.accounts)
    ? grok.json.accounts.filter(isRecord).find((row) => row.capability_source === "grok" && row.environment === "production" && row.status === "active")
    : undefined;
  assertJsonShape(codexAccount, { id: expect.any(String) });
  assertJsonShape(grokAccount, { id: expect.any(String) });
  return { codex: (codexAccount as { id: string }).id, grok: (grokAccount as { id: string }).id };
}

async function issue(userId: string, scopes: string[], bindings: Array<{ surface_grant: string; credential_account_id: string }>, keys: OwnedCreditKey[]): Promise<{ id: string; token: string }> {
  const issued = await admin("POST", `/admin/users/${userId}/keys`, {
    name: "Live key",
    scopes,
    credential_bindings: bindings,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  });
  if (isRecord(issued.json) && isRecord(issued.json.key) && typeof issued.json.key.id === "string") {
    keys.push({ id: issued.json.key.id, token: typeof issued.json.api_key === "string" ? issued.json.api_key : undefined });
  }
  expect(issued.status).toBe(201);
  assertJsonShape(issued.json, { key: { id: expect.any(String) }, api_key: expect.any(String) });
  const body = issued.json as { key: { id: string }; api_key: string };
  return { id: body.key.id, token: body.api_key };
}

async function codexModelId(key: string): Promise<string> {
  const catalog = await send("https://api.trustedtunnel.app/v1/models", key);
  expect(catalog.status).toBe(200);
  const body = parseJson(catalog.text);
  assertJsonShape(body, { models: expect.any(Array) });
  const slug = isRecord(body) && Array.isArray(body.models)
    ? body.models.filter(isRecord).map((model) => model.slug).find((id) => typeof id === "string" && !/audio|realtime|transcribe|tts|whisper|image|embedding|moderation/i.test(id))
    : undefined;
  expect(slug).toEqual(expect.any(String));
  return slug as string;
}
