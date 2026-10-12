import { describe, expect, it } from "vitest";
import { handleRequest } from "../../src/router";
import { TEST_IDENTITY_VERSION } from "../support/identity-version";
import {
  admin,
  createKey,
  createUser,
  importSharedAuth,
  makeFixture,
  type Fixture
} from "../router/fixture";

const EGRESS = "https://codex-egress-us-west1-a.trustedtunnel.app";
const CODEX = "https://api.trustedtunnel.app";
const ACTOR_HEADER = "x-openai-actor-authorization";
const ACTOR_SECRET = "caller-spoofed-test-actor-secret";
const FORGED_ACCOUNT = "acct_forged_caller";
const KEPT_HEADER = "x-future-custom-header";
const KEPT_VALUE = "keep-me";
const SELECTED_AUTHORIZATION = "Bearer shared_access";
const SELECTED_ACCOUNT = "acct_shared";
const RESPONSES_SSE = [
  "event: response.completed",
  "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_usage\",\"object\":\"response\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":23,\"input_tokens_details\":{\"cached_tokens\":3},\"output_tokens\":178,\"output_tokens_details\":{\"reasoning_tokens\":163},\"total_tokens\":201}}}",
  ""
].join("\n");

describe("Codex actor authorization isolation", () => {
  it("strips a caller actor credential before canonical, legacy, and models egress", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "actor-isolation@example.com");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    const responsesBody = new TextEncoder().encode(JSON.stringify({
      model: "gpt-5.4",
      input: "with-usage",
      stream: true,
      previous_response_id: "resp_actor_case"
    }));

    const cases = [
      {
        url: `${CODEX}/backend-api/codex/responses`,
        method: "POST",
        actorHeaderName: "X-OpenAI-Actor-Authorization",
        body: responsesBody,
        egressUrl: `${EGRESS}/responses`,
        contentType: "text/event-stream",
        output: RESPONSES_SSE,
        plan: "codex.responses",
        charge: 1
      },
      {
        url: `${CODEX}/v1/responses`,
        method: "POST",
        actorHeaderName: "x-OpEnAi-AcToR-aUtHoRiZaTiOn",
        body: responsesBody,
        egressUrl: `${EGRESS}/responses`,
        contentType: "text/event-stream",
        output: RESPONSES_SSE,
        plan: "codex.responses",
        charge: 1
      },
      {
        url: `${CODEX}/backend-api/codex/models`,
        method: "GET",
        actorHeaderName: "X-OPENAI-ACTOR-AUTHORIZATION",
        body: undefined,
        egressUrl: `${EGRESS}/models?client_version=${TEST_IDENTITY_VERSION}`,
        contentType: "application/json",
        output: '{"models":[{"slug":"upstream-model"}]}',
        plan: "codex.models",
        charge: 0
      }
    ] as const;

    for (const item of cases) {
      const result = await dispatch(fixture, item.url, key.api_key, user.user.id, item.method, item.actorHeaderName, item.body);
      expect(result.response.status, item.url).toBe(200);
      expect(result.response.headers.get("content-type"), item.url).toBe(item.contentType);
      expect(headerReflectsActor(result.response.headers), item.url).toBe(false);
      expect(result.text, item.url).toBe(item.output);
      expect(result.text, item.url).not.toContain(ACTOR_SECRET);
      expect(result.fetchCount, item.url).toBe(1);
      expect(result.call?.url, item.url).toBe(item.egressUrl);
      expect(result.call?.method, item.url).toBe(item.method);
      expect(result.call?.url, item.url).not.toContain("api.openai.com");
      expect(result.call?.rawBody, item.url).toEqual(item.body ?? new Uint8Array());
      expect(selectedEgress(result.call!.headers, key.api_key), item.url).toEqual({
        authorization: SELECTED_AUTHORIZATION,
        account: SELECTED_ACCOUNT,
        kept: KEPT_VALUE
      });
      expect(result.audits, item.url).toEqual([
        expect.objectContaining({
          user_id: user.user.id,
          key_id: key.key.id,
          route_profile_id: item.plan,
          status: "ok",
          upstream_status: 200
        })
      ]);
      expect(result.credit.consumed - result.creditBefore.consumed, item.url).toBe(item.charge);
      expect(result.credit.admitted - result.creditBefore.admitted, item.url).toBe(item.charge);
    }
  });

  it("does not dispatch a denied wrong surface or nonexistent route carrying actor authorization", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "actor-denied@example.com");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    const before = await codexCredit(fixture, user.user.id);

    const missing = await handleRequest(new Request(`${CODEX}/backend-api/codex/not-a-route`, {
      method: "POST",
      headers: callerHeaders(key.api_key, "X-OpenAI-Actor-Authorization", true),
      body: "{}"
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(missing.status).toBe(404);
    expect(headerReflectsActor(missing.headers)).toBe(false);
    const missingBody = await missing.text();
    expect(missingBody).not.toContain(ACTOR_SECRET);
    expect(JSON.parse(missingBody)).toMatchObject({ error: { code: "not_found" } });

    const wrongSurface = await handleRequest(new Request("https://grok.trustedtunnel.app/v1/models", {
      headers: callerHeaders(key.api_key, "X-OpenAI-Actor-Authorization", false)
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(wrongSurface.status).toBe(403);
    expect(headerReflectsActor(wrongSurface.headers)).toBe(false);
    const wrongSurfaceBody = await wrongSurface.text();
    expect(wrongSurfaceBody).not.toContain(ACTOR_SECRET);
    expect(JSON.parse(wrongSurfaceBody)).toMatchObject({ error: { code: "scope_denied" } });

    await fixture.ctx.flush();
    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.db.audit).toHaveLength(0);
    expect(await codexCredit(fixture, user.user.id)).toEqual(before);
    expect(fixture.fetchCalls.some((call) => call.url.includes("api.openai.com"))).toBe(false);
  });
});

function callerHeaders(apiKey: string, actorHeaderName: string, post: boolean): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${apiKey}`,
    "Chatgpt-Account-Id": FORGED_ACCOUNT,
    [actorHeaderName]: ACTOR_SECRET,
    "X-Future-Custom-Header": KEPT_VALUE
  });
  if (post) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

async function dispatch(
  fixture: Fixture,
  url: string,
  apiKey: string,
  userId: string,
  method: string,
  actorHeaderName: string,
  body?: Uint8Array
) {
  const creditBefore = await codexCredit(fixture, userId);
  const fetchBefore = fixture.fetchCalls.length;
  const auditBefore = fixture.db.audit.length;
  const response = await handleRequest(new Request(url, {
    method,
    headers: callerHeaders(apiKey, actorHeaderName, method === "POST"),
    body: requestBody(body)
  }), fixture.env, fixture.ctx, fixture.deps);
  const text = await response.text();
  await fixture.ctx.flush();
  return {
    response,
    text,
    call: fixture.fetchCalls[fetchBefore],
    fetchCount: fixture.fetchCalls.length - fetchBefore,
    audits: fixture.db.audit.slice(auditBefore),
    creditBefore,
    credit: await codexCredit(fixture, userId)
  };
}

function headerReflectsActor(headers: Headers): boolean {
  for (const [name, value] of headers) {
    if (name.toLowerCase() === ACTOR_HEADER || value.includes(ACTOR_SECRET)) {
      return true;
    }
  }
  return false;
}

function selectedEgress(headers: Headers, apiKey: string): { authorization: string | null; account: string | null; kept: string | null } {
  const names = [...headers.keys()].map((name) => name.toLowerCase());
  expect(names).not.toContain(ACTOR_HEADER);
  expect(headers.get(ACTOR_HEADER)).toBeNull();
  const manifest = JSON.parse(headers.get("x-mini-header-manifest") ?? "null") as unknown;
  expect(Array.isArray(manifest)).toBe(true);
  const manifestNames = (manifest as string[]).map((name) => name.toLowerCase());
  expect(manifestNames).not.toContain(ACTOR_HEADER);
  expect(manifestNames).toContain("authorization");
  expect(manifestNames).toContain("chatgpt-account-id");
  expect(manifestNames).toContain(KEPT_HEADER);
  for (const [name, value] of headers) {
    expect(name.toLowerCase()).not.toBe(ACTOR_HEADER);
    expect(value).not.toContain(ACTOR_SECRET);
    expect(value).not.toContain(apiKey);
    expect(value).not.toContain(FORGED_ACCOUNT);
  }
  return {
    authorization: headers.get("Authorization"),
    account: headers.get("Chatgpt-Account-Id"),
    kept: headers.get(KEPT_HEADER)
  };
}

function requestBody(bytes: Uint8Array | undefined): ArrayBuffer | undefined {
  if (bytes === undefined) {
    return undefined;
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function codexCredit(fixture: Fixture, userId: string): Promise<{ consumed: number; admitted: number }> {
  const response = await admin(fixture, `https://api.trustedtunnel.app/admin/users/${userId}/credits`, { method: "GET" });
  expect(response.status).toBe(200);
  const body = await response.json() as {
    states: Array<{ surface_grant: string; consumed_credits: number; admitted_attempts: number }>;
  };
  const codex = body.states.find((state) => state.surface_grant === "surface:codex:production");
  expect(codex).toBeDefined();
  return { consumed: codex!.consumed_credits, admitted: codex!.admitted_attempts };
}
