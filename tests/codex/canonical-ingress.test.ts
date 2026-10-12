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
const MODELS_BODY = '{"models":[{"slug":"upstream-model"}]}';
const RESPONSES_SSE = [
  "event: response.completed",
  "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_usage\",\"object\":\"response\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":23,\"input_tokens_details\":{\"cached_tokens\":3},\"output_tokens\":178,\"output_tokens_details\":{\"reasoning_tokens\":163},\"total_tokens\":201}}}",
  ""
].join("\n");
const OPAQUE_SSE = [
  "event: response.completed",
  "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_sse\",\"object\":\"response\"}}",
  ""
].join("\n");
const FALLBACK_USER_AGENT = `codex_cli_rs/${TEST_IDENTITY_VERSION} (Linux 6.6; x86_64) unknown`;

describe("canonical Codex ingress", () => {
  it("sends canonical and legacy HTTP operations to the same ChatGPT egress without rewriting bodies", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "canonical@example.com");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    const responsesBody = new TextEncoder().encode(JSON.stringify({
      model: "gpt-5.4",
      input: "with-usage",
      stream: true,
      previous_response_id: "resp_public"
    }));
    const realtimeBody = new TextEncoder().encode(JSON.stringify({
      model: "gpt-4o-realtime-preview",
      sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n"
    }));
    const liveBody = new TextEncoder().encode(JSON.stringify({
      sdp: "v=0",
      session: { type: "realtime", instructions: "client-selected" }
    }));
    const audioBody = Uint8Array.from([0xff, 0x00, 0x61, 0x75, 0x64, 0x69, 0x6f]);

    const cases = [
      {
        canonical: `${CODEX}/backend-api/codex/models?client_version=0.144.0&future=keep`,
        legacy: `${CODEX}/v1/models?client_version=0.144.0&future=keep`,
        method: "GET",
        body: undefined,
        egressUrl: `${EGRESS}/models?future=keep&client_version=${TEST_IDENTITY_VERSION}`,
        output: MODELS_BODY,
        plan: "codex.models",
        route: "/backend-api/codex/models",
        charge: 0,
        usageRequests: null
      },
      {
        canonical: `${CODEX}/backend-api/codex/responses?future=keep%2F1`,
        legacy: `${CODEX}/v1/responses?future=keep%2F1`,
        method: "POST",
        body: responsesBody,
        egressUrl: `${EGRESS}/responses?future=keep%2F1`,
        output: RESPONSES_SSE,
        plan: "codex.responses",
        route: "/backend-api/codex/responses",
        charge: 1,
        usageRequests: 1
      },
      {
        canonical: `${CODEX}/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`,
        legacy: `${CODEX}/v1/realtime/calls?intent=quicksilver&architecture=avas`,
        method: "POST",
        body: realtimeBody,
        egressUrl: `${EGRESS}/realtime/calls?intent=quicksilver&architecture=avas`,
        output: OPAQUE_SSE,
        plan: "codex.realtime_calls",
        route: "/backend-api/codex/realtime/calls",
        charge: 1,
        usageRequests: null
      },
      {
        canonical: `${CODEX}/backend-api/codex/live?client=selected`,
        legacy: `${CODEX}/v1/live?client=selected`,
        method: "POST",
        body: liveBody,
        egressUrl: `${EGRESS}/live?client=selected`,
        output: OPAQUE_SSE,
        plan: "codex.live",
        route: "/backend-api/codex/live",
        charge: 1,
        usageRequests: null
      },
      {
        canonical: `${CODEX}/backend-api/transcribe?language=en`,
        legacy: `${CODEX}/v1/audio/transcriptions?language=en`,
        method: "POST",
        body: audioBody,
        egressUrl: `${EGRESS}/transcribe?language=en`,
        output: OPAQUE_SSE,
        plan: "codex.audio_transcriptions",
        route: "/backend-api/transcribe",
        charge: 1,
        usageRequests: null
      }
    ] as const;

    for (const item of cases) {
      const first = await dispatch(fixture, item.canonical, key.api_key, user.user.id, item.method, item.body);
      const second = await dispatch(fixture, item.legacy, key.api_key, user.user.id, item.method, item.body);
      for (const result of [first, second]) {
        expect(result.response.status, item.route).toBe(200);
        expect(result.text, item.route).toBe(item.output);
        expect(result.fetchCount, item.route).toBe(1);
        expect(result.call?.url, item.route).toBe(item.egressUrl);
        expect(result.call?.method, item.route).toBe(item.method);
        expect(result.call?.authorization, item.route).toBe("Bearer shared_access");
        expect(result.call?.authorization, item.route).not.toContain(key.api_key);
        expect(result.call?.headers.get("Chatgpt-Account-Id"), item.route).toBe("acct_shared");
        expect(result.call?.headers.get("X-Codex-Egress-Secret"), item.route).toBe("egress-secret");
        expect(result.call?.headers.get("X-Future-Codex-Header"), item.route).toBe("preserve-me");
        expect(result.call?.url, item.route).not.toContain("api.openai.com");
        expect(result.call?.rawBody, item.route).toEqual(item.body ?? new Uint8Array());
        expect(result.audits, item.route).toEqual([
          expect.objectContaining({
            user_id: user.user.id,
            key_id: key.key.id,
            route_profile_id: item.plan,
            route: item.route,
            status: "ok",
            upstream_status: 200
          })
        ]);
        expect(result.credit.consumed - result.creditBefore.consumed, item.route).toBe(item.charge);
        expect(result.credit.admitted - result.creditBefore.admitted, item.route).toBe(item.charge);
      }
      expect(second.call?.url).toBe(first.call?.url);
      expect(second.call?.method).toBe(first.call?.method);
      expect(second.call?.rawBody).toEqual(first.call?.rawBody);
      expect(second.text).toBe(first.text);
      expect(headerRecord(second.call!.headers)).toMatchObject(headerRecord(first.call!.headers));
      if (item.plan === "codex.models" || item.plan === "codex.responses") {
        expect(first.call?.headers.get("Originator")).toBe("codex_cli_rs");
        expect(first.call?.headers.get("User-Agent")).toBe(FALLBACK_USER_AGENT);
      }
      if (item.usageRequests === null) {
        expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:${item.plan}:gpt-5.4`)).toBeUndefined();
        expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:${item.plan}:N/A`)).toBeUndefined();
      } else {
        expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:${item.plan}:gpt-5.4`)).toMatchObject({
          requests: item.usageRequests * 2,
          total_tokens: 201 * 2
        });
      }
    }

    const mixedCase = await dispatch(
      fixture,
      `https://API.trustedtunnel.app/v1/models?client_version=0.144.0&future=keep`,
      key.api_key,
      user.user.id,
      "GET"
    );
    expect(mixedCase.call?.url).toBe(`${EGRESS}/models?future=keep&client_version=${TEST_IDENTITY_VERSION}`);
    expect(mixedCase.text).toBe(MODELS_BODY);
  });

  it("returns the same typed 426 for canonical and legacy Responses upgrades", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "upgrade@example.com");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    const before = await codexCredit(fixture, user.user.id);

    for (const url of [
      `${CODEX}/backend-api/codex/responses`,
      `${CODEX}/v1/responses`
    ]) {
      const response = await handleRequest(new Request(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key.api_key}`,
          Upgrade: "websocket",
          Connection: "Upgrade"
        }
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(response.status, url).toBe(426);
      expect(response.headers.get("Upgrade")).toBe("websocket");
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "responses_websocket_not_supported" }
      });
    }

    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.db.audit).toHaveLength(0);
    expect(await codexCredit(fixture, user.user.id)).toEqual(before);
    const open = await handleRequest(new Request(`${CODEX}/backend-api/codex/responses`, {
      method: "GET",
      headers: { Upgrade: "websocket" }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(open.status).toBe(401);
    expect(fixture.fetchCalls).toHaveLength(0);
  });

  it("fails closed for removed public OpenAI speech and WebSocket routes", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "closed@example.com");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    const closed = [
      { url: `${CODEX}/v1/audio/speech`, method: "POST", websocket: false, status: 404, code: "not_found" },
      { url: `${CODEX}/backend-api/codex/audio/speech`, method: "POST", websocket: false, status: 404, code: "not_found" },
      { url: `${CODEX}/v1/realtime`, method: "GET", websocket: true, status: 404, code: "not_found" },
      { url: `${CODEX}/backend-api/codex/realtime`, method: "GET", websocket: true, status: 404, code: "not_found" },
      { url: `${CODEX}/v1/live/rtc_test`, method: "GET", websocket: true, status: 404, code: "not_found" },
      { url: `${CODEX}/backend-api/codex/live/rtc_test`, method: "GET", websocket: true, status: 404, code: "not_found" },
      { url: `${CODEX}/v1/live`, method: "GET", websocket: true, status: 405, code: "method_not_allowed" },
      { url: `${CODEX}/backend-api/codex/live`, method: "GET", websocket: true, status: 405, code: "method_not_allowed" }
    ];

    for (const route of closed) {
      const response = await handleRequest(new Request(route.url, {
        method: route.method,
        headers: {
          Authorization: `Bearer ${key.api_key}`,
          "Content-Type": "application/json",
          ...(route.websocket ? { Upgrade: "websocket", Connection: "Upgrade" } : {})
        },
        body: route.method === "POST" ? JSON.stringify({ input: "hello", voice: "alloy", model: "tts-1" }) : undefined
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(response.status, route.url).toBe(route.status);
      await expect(response.json()).resolves.toMatchObject({ error: { code: route.code } });
    }

    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.db.audit).toHaveLength(0);
    expect(fixture.db.usageDaily.size).toBe(0);
    expect(await codexCredit(fixture, user.user.id)).toEqual({ consumed: 0, admitted: 0 });
    expect(fixture.fetchCalls.some((call) => call.url.includes("api.openai.com"))).toBe(false);
  });

  it("rejects spoofed, encoded, and wrong-method Codex paths before dispatch", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "spoof@example.com");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    const missing = [
      `${CODEX}/backend-api/codex/v1/models`,
      `${CODEX}/backend-api/codex/models/extra`,
      `${CODEX}/backend-api/codex/models%2f..%2fresponses`,
      `${CODEX}/v1/models/extra`,
      `${CODEX}/v1/models/`,
      `${CODEX}/v1/audio/transcriptions/`,
      `${CODEX}/v1/audio/transcriptions/extra`,
      `${CODEX}/backend-api/codex/audio/transcriptions`,
      `${CODEX}/backend-api/codex/transcribe`,
      `${CODEX}/backend-api/codex`,
      "https://api.trustedtunnel.app.evil.example/v1/models",
      "https://api.trustedtunnel.app.evil.example/backend-api/codex/models"
    ];
    for (const url of missing) {
      const response = await handleRequest(new Request(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: "{}"
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(response.status, url).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
    }

    const wrongMethod = await handleRequest(new Request(`${CODEX}/v1/responses`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key.api_key}` }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("POST, GET");
    await expect(wrongMethod.json()).resolves.toMatchObject({ error: { code: "method_not_allowed" } });

    const wrongModels = await handleRequest(new Request(`${CODEX}/backend-api/codex/models`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key.api_key}`,
        "Content-Type": "application/json"
      },
      body: "{}"
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(wrongModels.status).toBe(405);
    expect(wrongModels.headers.get("Allow")).toBe("GET");

    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.db.audit).toHaveLength(0);
    expect(await codexCredit(fixture, user.user.id)).toEqual({ consumed: 0, admitted: 0 });
  });

  it("keeps Grok and xAI /v1 on their own providers and credentials", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "other-surfaces@example.com");
    const codexKey = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    const grokKey = await createKey(fixture, user.user.id, ["surface:grok:production"]);
    const xaiKey = await createKey(fixture, user.user.id, ["surface:xai:production"]);
    await importSharedAuth(fixture);
    fixture.db.updateSubscriptionAccount("sub_grok_test", "active", "2026-08-01T00:00:00.000Z");
    fixture.env.TOKEN_AUTHORITY.get(fixture.env.TOKEN_AUTHORITY.idFromName("subscription:sub_grok_test"));
    await fixture.tokenAuthority.saveSubscriptionCredential({
      access_token: "grok-production-provider-secret"
    });

    const denied = await handleRequest(new Request("https://grok.trustedtunnel.app/v1/models", {
      headers: { Authorization: `Bearer ${codexKey.api_key}` }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: "scope_denied" } });

    const grokNative = await handleRequest(new Request("https://grok.trustedtunnel.app/backend-api/codex/models", {
      headers: { Authorization: `Bearer ${grokKey.api_key}` }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(grokNative.status).toBe(404);
    await expect(grokNative.json()).resolves.toMatchObject({ error: { code: "not_found" } });

    const grok = await handleRequest(new Request("https://grok.trustedtunnel.app/v1/models", {
      headers: { Authorization: `Bearer ${grokKey.api_key}` }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(grok.status).toBe(200);
    await grok.text();
    await fixture.ctx.flush();
    expect(fixture.fetchCalls).toHaveLength(1);
    expect(fixture.fetchCalls[0]?.url).toBe("https://cli-chat-proxy.grok.com/v1/models");
    expect(fixture.fetchCalls[0]?.authorization).toBe("Bearer grok-production-provider-secret");
    expect(fixture.fetchCalls[0]?.authorization).not.toBe("Bearer shared_access");
    expect(fixture.db.audit.at(-1)).toMatchObject({
      route_profile_id: "grok.production.models",
      route: "/v1/models"
    });

    const xai = await handleRequest(new Request("https://xai.trustedtunnel.app/v1/models", {
      headers: { Authorization: `Bearer ${xaiKey.api_key}` }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(xai.status).toBe(200);
    await xai.text();
    await fixture.ctx.flush();
    expect(fixture.fetchCalls[1]?.url).toBe("https://api.x.ai/v1/models");
    expect(fixture.fetchCalls[1]?.authorization).toBe("Bearer grok-production-provider-secret");

    const xaiRealtime = await handleRequest(new Request("https://xai.trustedtunnel.app/v1/realtime?model=grok-voice", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${xaiKey.api_key}`,
        Upgrade: "websocket",
        Connection: "Upgrade"
      }
    }), fixture.env, fixture.ctx, fixture.deps);
    await xaiRealtime.text();
    await fixture.ctx.flush();
    expect(fixture.fetchCalls[2]?.url).toBe("https://api.x.ai/v1/realtime?model=grok-voice");
    expect(fixture.fetchCalls[2]?.authorization).toBe("Bearer grok-production-provider-secret");

    const codexRealtime = await handleRequest(new Request(`${CODEX}/v1/realtime?model=grok-voice`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${codexKey.api_key}`,
        Upgrade: "websocket"
      }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(codexRealtime.status).toBe(404);
    expect(fixture.fetchCalls).toHaveLength(3);
    expect(fixture.fetchCalls.every((call) => !call.url.includes("api.openai.com"))).toBe(true);

    const wrongSurface = await handleRequest(new Request(`${CODEX}/backend-api/codex/models`, {
      headers: { Authorization: `Bearer ${grokKey.api_key}` }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(wrongSurface.status).toBe(403);
    expect(fixture.fetchCalls).toHaveLength(3);
  });
});

async function dispatch(
  fixture: Fixture,
  url: string,
  apiKey: string,
  userId: string,
  method: string,
  body?: Uint8Array
) {
  const creditBefore = await codexCredit(fixture, userId);
  const fetchBefore = fixture.fetchCalls.length;
  const auditBefore = fixture.db.audit.length;
  const response = await handleRequest(new Request(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Future-Codex-Header": "preserve-me",
      "Chatgpt-Account-Id": "acct_attacker",
      ...(method === "POST" ? { "Content-Type": "application/octet-stream" } : {})
    },
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

function requestBody(bytes: Uint8Array | undefined): ArrayBuffer | undefined {
  if (bytes === undefined) {
    return undefined;
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (name.toLowerCase() === "x-mini-transport-trace-id") {
      continue;
    }
    record[name.toLowerCase()] = value;
  }
  return record;
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
