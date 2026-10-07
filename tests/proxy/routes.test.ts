import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { hmacSha256Hex, keyPrefix } from "../../src/crypto";
import { handleRequest } from "../../src/router";
import type { ExecutionDependencies } from "../../src/types";
import { seedIdentityVersions, TEST_IDENTITY_VERSION } from "../support/identity-version";
import { createTestD1, type TestD1 } from "../support/sqlite-d1";

const MINI_KEY = "cfwd_grok_route_profile_test_secret";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("Grok Route Profile", () => {
  it("forwards the Grok catalog opaquely to the CLI gateway", async () => {
    const upstreamBody = JSON.stringify({
      object: "list",
      data: [{ id: "provider-owned", object: "model", owned_by: "xai" }]
    });
    const fixture = await makeFixture(async (input, init) => {
      expect(String(input)).toBe("https://cli-chat-proxy.grok.com/v1/models");
      expect(init?.method).toBe("GET");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer grok-production-provider-secret");
      const stableVersion = TEST_IDENTITY_VERSION;
      expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
      expect(headers.get("x-authenticateresponse")).toBe("authenticate-response");
      expect(headers.get("x-grok-client-version")).toBe(stableVersion);
      expect(headers.get("x-grok-client-mode")).toBe("headless");
      expect(headers.get("x-grok-client-identifier")).toBe("grok-shell");
      expect(headers.get("User-Agent")).toBe(`grok-shell/${stableVersion} (linux; x86_64)`);
      return new Response(upstreamBody, {
        status: 200,
        headers: { "Content-Type": "application/json", "x-provider-catalog": "preserve" }
      });
    }, ["surface:grok:production"]);
    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/models",
      "GET",
      {
        Authorization: `Bearer ${MINI_KEY}`,
        "x-xai-token-auth": "caller-must-not-pass",
        "x-grok-client-version": "caller-must-not-pass",
        "x-grok-client-mode": "caller-must-not-pass"
      }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-provider-catalog")).toBe("preserve");
    await expect(response.text()).resolves.toBe(upstreamBody);
    await fixture.ctx.flush();
    expect(fixture.db.authLookupCount).toBe(1);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.db.audit).toHaveLength(1);
    expect(fixture.db.audit[0]).toMatchObject({
      route_profile_id: "grok.production.models",
      route: "/v1/models",
      status: "ok",
      upstream_status: 200,
      capability_source: "grok",
      ingress_protocol: "xai/grok",
      response_model: "N/A",
      total_tokens: null
    });
    expect(fixture.db.usageWrites).toBe(0);
  });

  it("returns a CLI-gateway catalog failure without fallback", async () => {
    const upstreamBody = JSON.stringify({ error: { type: "gateway_unavailable" } });
    const fixture = await makeFixture(async () => new Response(upstreamBody, {
      status: 503,
      headers: { "Content-Type": "application/json" }
    }), ["surface:grok:production"]);

    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/models",
      "GET",
      { Authorization: `Bearer ${MINI_KEY}` }
    );

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe(upstreamBody);
    await fixture.ctx.flush();
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.db.audit).toEqual([expect.objectContaining({
      route_profile_id: "grok.production.models",
      status: "error",
      upstream_status: 503
    })]);
  });

  it("forwards a proven xAI catalog path with the subscription OAuth slot", async () => {
    const upstreamBody = JSON.stringify({ models: [{ id: "provider-owned" }] });
    const fixture = await makeFixture(async (input, init) => {
      expect(String(input)).toBe("https://api.x.ai/v1/language-models?limit=1");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer grok-production-provider-secret");
      expect(headers.get("x-xai-token-auth")).toBeNull();
      expect(headers.get("x-grok-client-version")).toBeNull();
      expect(headers.get("x-grok-client-mode")).toBeNull();
      return new Response(upstreamBody, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }, ["surface:grok:production"]);

    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/language-models?limit=1",
      "GET",
      {
        Authorization: `Bearer ${MINI_KEY}`,
        "x-xai-token-auth": "caller-must-not-pass",
        "x-grok-client-version": "caller-must-not-pass",
        "x-grok-client-mode": "caller-must-not-pass"
      }
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(upstreamBody);
    await fixture.ctx.flush();
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.db.audit).toHaveLength(1);
    expect(fixture.db.audit[0]).toMatchObject({
      route_profile_id: "grok.production.language_models",
      route: "/v1/language-models",
      status: "ok",
      upstream_status: 200,
      capability_source: "grok",
      ingress_protocol: "xai/grok",
      response_model: "N/A",
      total_tokens: null
    });
    expect(fixture.db.usageWrites).toBe(0);
  });

  it("forwards tokenize-text bytes opaquely and keeps provider rejection metadata-only", async () => {
    const requestBytes = new Uint8Array([123, 34, 116, 101, 120, 116, 34, 58, 255, 125]);
    const upstreamBody = JSON.stringify({ error: { type: "invalid_request_error" } });
    const fixture = await makeFixture(async (input, init) => {
      expect(String(input)).toBe("https://api.x.ai/v1/tokenize-text?future=1");
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(requestBytes);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer grok-production-provider-secret");
      expect(headers.get("x-xai-token-auth")).toBeNull();
      return new Response(upstreamBody, {
        status: 422,
        headers: { "Content-Type": "application/json" }
      });
    }, ["surface:grok:production"]);

    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/tokenize-text?future=1",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      requestBytes
    );

    expect(response.status).toBe(422);
    await expect(response.text()).resolves.toBe(upstreamBody);
    await fixture.ctx.flush();
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.db.audit).toHaveLength(1);
    expect(fixture.db.audit[0]).toMatchObject({
      route_profile_id: "grok.production.tokenize_text",
      route: "/v1/tokenize-text",
      status: "error",
      upstream_status: 422,
      response_model: "N/A",
      total_tokens: null
    });
    expect(fixture.db.usageWrites).toBe(0);
  });

  it.each([
    {
      pathname: "/v1/chat/completions",
      planId: "grok.production.chat_completions",
      requestType: "application/json",
      requestBytes: new Uint8Array([123, 34, 109, 111, 100, 101, 108, 34, 58, 255, 125]),
      responseType: "application/json",
      responseBytes: new Uint8Array([123, 34, 99, 104, 111, 105, 99, 101, 115, 34, 58, 91, 93, 125])
    },
    {
      pathname: "/v1/tts",
      planId: "grok.production.tts",
      requestType: "application/json",
      requestBytes: new Uint8Array([123, 34, 116, 101, 120, 116, 34, 58, 255, 125]),
      responseType: "audio/mpeg",
      responseBytes: new Uint8Array([73, 68, 51, 4, 0, 255, 1, 2])
    },
    {
      pathname: "/v1/stt",
      planId: "grok.production.stt",
      requestType: "multipart/form-data; boundary=opaque-probe",
      requestBytes: new Uint8Array([45, 45, 111, 112, 97, 113, 117, 101, 255, 13, 10]),
      responseType: "application/json",
      responseBytes: new Uint8Array([123, 34, 100, 117, 114, 97, 116, 105, 111, 110, 34, 58, 49, 125])
    }
  ])(
    "forwards $pathname bytes opaquely with isolated subscription OAuth and metadata-only audit",
    async ({ pathname, planId, requestType, requestBytes, responseType, responseBytes }) => {
      const fixture = await makeFixture(async (input, init) => {
        expect(String(input)).toBe(`https://api.x.ai${pathname}?future=1`);
        expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(requestBytes);
        const headers = new Headers(init?.headers);
        expect(headers.get("Authorization")).toBe("Bearer grok-production-provider-secret");
        expect(headers.get("Content-Type")).toBe(requestType);
        expect(headers.get("x-xai-token-auth")).toBeNull();
        expect(headers.get("x-grok-client-version")).toBeNull();
        expect(headers.get("x-grok-client-mode")).toBeNull();
        return new Response(responseBytes, {
          status: 200,
          headers: { "Content-Type": responseType, "x-provider-control": "preserve" }
        });
      }, ["surface:grok:production"]);

      const response = await profileRequest(
        fixture,
        "grok.trustedtunnel.app",
        `${pathname}?future=1`,
        "POST",
        {
          Authorization: `Bearer ${MINI_KEY}`,
          "Content-Type": requestType,
          "x-xai-token-auth": "caller-must-not-pass",
          "x-grok-client-version": "caller-must-not-pass",
          "x-grok-client-mode": "caller-must-not-pass"
        },
        requestBytes
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain(responseType);
      expect(response.headers.get("x-provider-control")).toBe("preserve");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(responseBytes);
      await fixture.ctx.flush();
      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.db.audit).toHaveLength(1);
      expect(fixture.db.audit[0]).toMatchObject({
        route_profile_id: planId,
        route: pathname,
        status: "ok",
        upstream_status: 200,
        capability_source: "grok",
        ingress_protocol: "xai/grok",
        response_model: "N/A",
        total_tokens: null
      });
      expect(fixture.db.usageWrites).toBe(0);
    }
  );

  it("forwards one Responses request, writes Grok audit, and upserts usage_daily", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    onTestFinished(() => logSpy.mockRestore());
    const requestBody = "{\"model\":\"grok-4.3\",\"input\":\"fixture\"}";
    const upstreamBody = JSON.stringify({
      id: "resp_fixture",
      object: "response",
      status: "completed",
      model: "grok-4.5",
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
        cost_in_usd_ticks: 11344000
      }
    });
    const fixture = await makeFixture(async (input, init) => {
      expect(String(input)).toBe("https://cli-chat-proxy.grok.com/v1/responses?future=1");
      await expect(new Response(init?.body).text()).resolves.toBe(requestBody);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer grok-production-provider-secret");
      expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
      expect(headers.get("x-authenticateresponse")).toBe("authenticate-response");
      const stableVersion = TEST_IDENTITY_VERSION;
      expect(headers.get("x-grok-client-version")).toBe(stableVersion);
      expect(headers.get("x-grok-client-mode")).toBe("headless");
      expect(headers.get("x-grok-client-identifier")).toBe("grok-shell");
      expect(headers.get("User-Agent")).toBe(`grok-shell/${stableVersion} (linux; x86_64)`);
      expect(headers.get("x-grok-user-id")).toBeNull();
      expect(headers.get("x-grok-deployment-id")).toBeNull();
      return new Response(upstreamBody, {
        status: 201,
        statusText: "Created",
        headers: { "Content-Type": "application/json", "x-request-id": "upstream-grok-id" }
      });
    }, ["surface:grok:production"]);

    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/responses?future=1",
      "POST",
      {
        Authorization: `Bearer ${MINI_KEY}`,
        "Content-Type": "application/json",
        "x-authenticateresponse": "caller-must-not-pass",
        "x-grok-client-version": "caller-must-not-pass",
        "x-grok-client-mode": "interactive",
        "x-grok-client-identifier": "caller-must-not-pass",
        "x-grok-user-id": "caller-must-not-pass",
        "x-grok-deployment-id": "caller-must-not-pass"
      },
      requestBody
    );

    expect(response.status).toBe(201);
    await expect(response.text()).resolves.toBe(upstreamBody);
    await fixture.ctx.flush();
    expect(fixture.db.audit).toHaveLength(1);
    expect(fixture.db.audit[0]).toMatchObject({
      route: "/v1/responses",
      status: "ok",
      upstream_status: 201,
      capability_source: "grok",
      ingress_protocol: "xai/grok",
      response_model: "grok-4.5",
      total_tokens: 18
    });
    expect(fixture.db.usageWrites).toBe(1);
    expect(fixture.db.usageDaily[0]).toMatchObject({
      user_id: "user_grok",
      route_profile_id: "grok.production.responses",
      response_model: "grok-4.5",
      total_tokens: 18,
      token_measurements: 1,
      provider_cost_usd_ticks: 11344000,
      cost_measurements: 1,
      requests: 1,
      ok_requests: 1
    });
    expect(logSpy.mock.calls.map(([entry]) => JSON.parse(String(entry))))
      .toContainEqual(expect.objectContaining({
        event: "provider_attempt_timing",
        plan_id: "grok.production.responses",
        outcome: "completed",
        upstream_status: 201,
        auth_ms: 0,
        credential_slot_ms: 0,
        credit_admission_ms: 0,
        request_to_admission_ms: 0,
        provider_headers_ms: 0,
        request_to_upstream_headers_ms: 0
      }));
  });

  it("forwards image generation to api.x.ai and records only media usage", async () => {
    const requestBytes = new Uint8Array([123, 34, 112, 114, 111, 109, 112, 116, 34, 58, 255, 125]);
    const upstreamText = JSON.stringify({
      created: 1,
      data: [{
        b64_json: "opaque-image-data",
        mime_type: "image/jpeg",
        file_output: { file_id: "file_image-output" }
      }],
      model: "must-not-be-observed",
      usage: { cost_in_usd_ticks: 200000000 }
    });
    const upstreamBytes = new TextEncoder().encode(upstreamText);
    const fixture = await makeFixture(async (input, init) => {
      expect(String(input)).toBe("https://api.x.ai/v1/images/generations?future=1");
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(requestBytes);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer grok-production-provider-secret");
      expect(headers.get("x-xai-token-auth")).toBeNull();
      expect(headers.get("x-grok-client-version")).toBeNull();
      expect(headers.get("x-grok-client-mode")).toBeNull();
      const firstBoundary = upstreamText.indexOf("file_id") + 4;
      const secondBoundary = upstreamText.indexOf("cost_in_usd_ticks") + 7;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(upstreamBytes.slice(0, firstBoundary));
          controller.enqueue(upstreamBytes.slice(firstBoundary, secondBoundary));
          controller.enqueue(upstreamBytes.slice(secondBoundary));
          controller.close();
        }
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }, ["surface:grok:production"]);

    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/images/generations?future=1",
      "POST",
      {
        Authorization: `Bearer ${MINI_KEY}`,
        "Content-Type": "application/json",
        "x-xai-token-auth": "caller-must-not-pass",
        "x-grok-client-version": "caller-must-not-pass",
        "x-grok-client-mode": "caller-must-not-pass"
      },
      requestBytes
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(upstreamBytes);
    await fixture.ctx.flush();
    expect(fixture.db.audit).toHaveLength(1);
    expect(fixture.db.audit[0]).toMatchObject({
      route_profile_id: "grok.production.images_generations",
      route: "/v1/images/generations",
      status: "ok",
      upstream_status: 200,
      capability_source: "grok",
      ingress_protocol: "xai/grok",
      response_model: "N/A",
      total_tokens: null
    });
    expect(fixture.db.usageWrites).toBe(0);
    expect(fixture.db.usageDaily).toHaveLength(0);
    expect(fixture.db.fileOwners).toHaveLength(1);
    expect(fixture.db.fileOwners[0]).toMatchObject({
      user_id: "user_grok",
      source: "image_output"
    });
    expect(fixture.db.imageMediaUsage).toEqual([expect.objectContaining({
      user_id: "user_grok",
      route_profile_id: "grok.production.images_generations",
      capability: "image_generation",
      completed_jobs: 1,
      failed_jobs: 0,
      outputs: 1,
      output_measurements: 1,
      provider_cost_usd_ticks: 200000000,
      cost_measurements: 1
    })]);
  });

  it("observes only exact image metadata paths and ignores JSON-shaped text", async () => {
    const upstreamBytes = new TextEncoder().encode(JSON.stringify({
      data: [{
        revised_prompt: "ignore nested text: \"file_id\":\"file_deceptive\", \"cost_in_usd_ticks\":999999999",
        metadata: { usage: { cost_in_usd_ticks: 888888888 } },
        file_output: { file_id: "file_exact-output" }
      }],
      metadata: { cost_in_usd_ticks: 777777777 },
      usage: { cost_in_usd_ticks: 200000000 }
    }));
    const fixture = await makeFixture(async () => new Response(upstreamBytes, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }), ["surface:grok:production"]);

    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/images/generations",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      "{}"
    );

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(upstreamBytes);
    await fixture.ctx.flush();
    expect(fixture.db.fileOwners).toEqual([expect.objectContaining({
      file_id_hash: await hmacSha256Hex("pepper-secret", "xai-file:v1:file_exact-output")
    })]);
    expect(fixture.db.fileOwners[0]?.file_id_hash).not.toBe(
      await hmacSha256Hex("pepper-secret", "xai-file:v1:file_deceptive")
    );
    expect(fixture.db.imageMediaUsage).toEqual([expect.objectContaining({
      outputs: 1,
      output_measurements: 1,
      provider_cost_usd_ticks: 200000000,
      cost_measurements: 1
    })]);
  });

  it("leaves image measurements unknown for malformed JSON or metadata limits", async () => {
    const bodies = [
      new TextEncoder().encode(`${JSON.stringify({
        data: [{ file_output: { file_id: "file_before-trailing-garbage" } }],
        usage: { cost_in_usd_ticks: 200000000 }
      })} trailing-garbage`),
      new TextEncoder().encode(JSON.stringify({
        data: Array.from({ length: 65 }, (_, index) => ({
          file_output: { file_id: `file_limit-${index}` }
        })),
        usage: { cost_in_usd_ticks: 200000000 }
      }))
    ];

    for (const upstreamBytes of bodies) {
      const fixture = await makeFixture(async () => new Response(upstreamBytes, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }), ["surface:xai:production"]);
      const response = await profileRequest(
        fixture,
        "xai.trustedtunnel.app",
        "/v1/images/generations",
        "POST",
        { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
        "{}"
      );

      expect(new Uint8Array(await response.arrayBuffer())).toEqual(upstreamBytes);
      await fixture.ctx.flush();
      expect(fixture.db.imageMediaUsage).toEqual([expect.objectContaining({
        outputs: 0,
        output_measurements: 0,
        provider_cost_usd_ticks: 0,
        cost_measurements: 0
      })]);
    }
  });

  it("records a failed Responses attempt as an explicit unmeasured coverage outcome", async () => {
    const fixture = await makeFixture(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://unexpected.example/responses" }
    }), ["surface:grok:production"]);

    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/responses",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      "{}"
    );

    await expectOpenAIError(response, 502, "upstream_redirect_rejected");
    await fixture.ctx.flush();
    expect(fixture.db.audit).toEqual([expect.objectContaining({
      route_profile_id: "grok.production.responses",
      status: "error",
      upstream_status: 302,
      error_code: "upstream_redirect_rejected"
    })]);
    expect(fixture.db.usageDaily).toEqual([expect.objectContaining({
      route_profile_id: "grok.production.responses",
      requests: 1,
      ok_requests: 0,
      error_requests: 1,
      token_measurements: 0,
      cost_measurements: 0
    })]);
  });

  it("counts a rejected image redirect as one failed usage request", async () => {
    const fixture = await makeFixture(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://unexpected.example/image" }
    }), ["surface:grok:production"]);

    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/images/generations",
      "POST",
      {
        Authorization: `Bearer ${MINI_KEY}`,
        "Content-Type": "application/json"
      },
      "{}"
    );

    await expectOpenAIError(response, 502, "upstream_redirect_rejected");
    await fixture.ctx.flush();
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.db.audit).toHaveLength(1);
    expect(fixture.db.audit[0]).toMatchObject({
      route_profile_id: "grok.production.images_generations",
      status: "error",
      upstream_status: 302,
      response_model: "N/A"
    });
    expect(fixture.db.usageWrites).toBe(0);
    expect(fixture.db.usageDaily).toHaveLength(0);
    expect(fixture.db.imageMediaUsage).toEqual([expect.objectContaining({
      capability: "image_generation",
      completed_jobs: 0,
      failed_jobs: 1,
      outputs: 0,
      cost_measurements: 0
    })]);
  });

  it("classifies an image file binding failure as a failed client delivery", async () => {
    const upstreamBytes = new TextEncoder().encode(JSON.stringify({
      data: [{
        url: "https://imgen.x.ai/temporary/image.jpg",
        mime_type: "image/jpeg",
        file_output: { file_id: "file_unbound-image" }
      }],
      usage: { cost_in_usd_ticks: 200000000 }
    }));
    const fixture = await makeFixture(async () => new Response(upstreamBytes, {
      headers: { "Content-Type": "application/json" }
    }));
    fixture.db.failFileOwnerInsert = true;

    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/images/generations",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      "{}"
    );

    await expect(response.arrayBuffer()).rejects.toThrow("ownership could not be committed");
    await fixture.ctx.flush();
    expect(fixture.db.audit.at(-1)).toMatchObject({
      route_profile_id: "grok.production.images_generations",
      status: "error",
      upstream_status: 200,
      error_code: "xai_file_binding_failed"
    });
    expect(fixture.db.usageDaily).toHaveLength(0);
    expect(fixture.db.imageMediaUsage.at(-1)).toMatchObject({
      completed_jobs: 0,
      failed_jobs: 1,
      outputs: 1,
      output_measurements: 1,
      provider_cost_usd_ticks: 200000000,
      cost_measurements: 1
    });
    expect(fixture.db.subscriptionLastSuccessAt).toBe("2026-07-23T00:00:00.000Z");
  });

  it("forwards image editing as opaque JSON and accounts one media request", async () => {
    const requestBytes = new Uint8Array([123, 34, 105, 109, 97, 103, 101, 34, 58, 255, 125]);
    const upstreamBytes = new TextEncoder().encode(JSON.stringify({
      data: [{ url: "https://imgen.x.ai/temporary/edit.jpg", mime_type: "image/jpeg" }],
      usage: { cost_in_usd_ticks: 220000000 }
    }));
    const fixture = await makeFixture(async (input, init) => {
      expect(String(input)).toBe("https://api.x.ai/v1/images/edits");
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(requestBytes);
      expect(new Headers(init?.headers).get("Authorization"))
        .toBe("Bearer grok-production-provider-secret");
      return new Response(upstreamBytes, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/images/edits",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      requestBytes
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(upstreamBytes);
    await fixture.ctx.flush();
    expect(fixture.db.audit.at(-1)).toMatchObject({
      route_profile_id: "grok.production.images_edits",
      route: "/v1/images/edits",
      status: "ok",
      upstream_status: 200,
      response_model: "N/A"
    });
    expect(fixture.db.usageWrites).toBe(0);
    expect(fixture.db.usageDaily).toHaveLength(0);
    expect(fixture.db.imageMediaUsage).toEqual([expect.objectContaining({
      capability: "image_edit",
      completed_jobs: 1,
      outputs: 1,
      provider_cost_usd_ticks: 220000000
    })]);
  });

  it("binds a Files upload response before returning the provider bytes", async () => {
    const requestBytes = new TextEncoder().encode("opaque-multipart-body");
    const fileId = "file_upload-owned";
    const upstreamBytes = new TextEncoder().encode(JSON.stringify({
      id: fileId,
      object: "file",
      filename: "probe.txt",
      expires_at: 1785578400
    }));
    const fixture = await makeFixture(async (input, init) => {
      expect(String(input)).toBe("https://api.x.ai/v1/files");
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(requestBytes);
      return new Response(upstreamBytes, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/files",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "multipart/form-data; boundary=x" },
      requestBytes
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(upstreamBytes);
    expect(fixture.db.fileOwners).toHaveLength(1);
    expect(fixture.db.fileOwners[0]).toMatchObject({
      user_id: "user_grok",
      source: "upload",
      expires_at: "2026-08-01T10:00:00.000Z"
    });
    expect(fixture.db.fileOwners[0]?.file_id_hash).not.toContain(fileId);
  });

  it("rejects an unowned Files operation before slot resolution and provider fetch", async () => {
    const fixture = await makeFixture(vi.fn());
    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/files/file_unknown/content",
      "GET",
      { Authorization: `Bearer ${MINI_KEY}` }
    );
    await expectOpenAIError(response, 404, "xai_file_not_found");
    expect(fixture.slotResolveCount()).toBe(0);
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("streams owner-bound file content and removes ownership after provider deletion", async () => {
    const fileId = "file_owned-resource";
    const content = new Uint8Array([0, 1, 2, 255]);
    const fixture = await makeFixture(async (input, init) => {
      if (init?.method === "DELETE") {
        return Response.json({ id: fileId, deleted: true });
      }
      expect(String(input)).toBe(`https://api.x.ai/v1/files/${fileId}/content`);
      return new Response(content, { headers: { "Content-Type": "application/octet-stream" } });
    });
    await fixture.db.bindFileOwner(fileId, "user_grok", "upload");

    const download = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      `/v1/files/${fileId}/content`,
      "GET",
      { Authorization: `Bearer ${MINI_KEY}` }
    );
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(content);
    await fixture.ctx.flush();
    expect(fixture.db.audit.at(-1)).toMatchObject({
      route_profile_id: "grok.production.files_content",
      status: "ok",
      upstream_status: 200
    });
    expect(fixture.db.usageWrites).toBe(0);

    const deletion = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      `/v1/files/${fileId}`,
      "DELETE",
      { Authorization: `Bearer ${MINI_KEY}` }
    );
    expect(deletion.status).toBe(200);
    await deletion.arrayBuffer();
    await fixture.ctx.flush();
    expect(fixture.db.fileOwners).toHaveLength(0);
  });

  it("does not replace a successful provider delete when owner cleanup fails", async () => {
    const fileId = "file_cleanup-failure";
    const upstreamBytes = new TextEncoder().encode(JSON.stringify({ id: fileId, deleted: true }));
    const fixture = await makeFixture(async () => new Response(upstreamBytes, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    await fixture.db.bindFileOwner(fileId, "user_grok", "upload");
    fixture.db.failFileOwnerDelete = true;

    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      `/v1/files/${fileId}`,
      "DELETE",
      { Authorization: `Bearer ${MINI_KEY}` }
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(upstreamBytes);
    await fixture.ctx.flush();
    expect(fixture.db.audit.at(-1)).toMatchObject({
      route_profile_id: "grok.production.files_delete",
      status: "ok",
      upstream_status: 200
    });
  });

  it("starts a video with opaque request bytes and binds the provider job before returning", async () => {
    const requestBytes = new Uint8Array([123, 34, 105, 109, 97, 103, 101, 34, 58, 255, 125]);
    const upstreamBytes = new TextEncoder().encode(
      "{\"request_id\":\"d97415a1-5796-b7ec-379f-4e6819e08fdf\"}"
    );
    const fixture = await makeFixture(async (input, init) => {
      expect(String(input)).toBe("https://api.x.ai/v1/videos/generations");
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(requestBytes);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer grok-production-provider-secret");
      expect(headers.get("x-xai-token-auth")).toBeNull();
      expect(headers.get("Accept-Encoding")).toBe("identity");
      return new Response(upstreamBytes, {
        status: 200,
        headers: { "Content-Type": "application/json", "x-provider-control": "preserve" }
      });
    });

    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/videos/generations",
      "POST",
      {
        Authorization: `Bearer ${MINI_KEY}`,
        "Content-Type": "application/json",
        "x-xai-token-auth": "caller-must-not-pass"
      },
      requestBytes
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-provider-control")).toBe("preserve");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(upstreamBytes);
    expect(fixture.db.videoJobs).toHaveLength(1);
    expect(fixture.db.videoJobs[0]).toMatchObject({
      user_id: "user_grok",
      route_profile_id: "grok.production.videos_generations",
      status: "pending",
      capability: "video_generation"
    });
    expect(fixture.db.videoJobs[0]?.request_id_hash).not.toContain("d97415a1");
    expect(fixture.db.mediaStartedJobs).toBe(1);
    await fixture.ctx.flush();
    expect(fixture.db.audit.at(-1)).toMatchObject({
      route_profile_id: "grok.production.videos_generations",
      route: "/v1/videos/generations",
      status: "ok",
      upstream_status: 200,
      response_model: "N/A"
    });
    expect(fixture.db.usageWrites).toBe(0);
  });

  it.each([
    ["/v1/videos/edits", "grok.production.videos_edits", "video_edit"],
    ["/v1/videos/extensions", "grok.production.videos_extensions", "video_extension"]
  ] as const)(
    "starts %s opaquely and binds its accounting capability",
    async (pathname, planId, capability) => {
      const requestBytes = new Uint8Array([123, 34, 118, 105, 100, 101, 111, 34, 58, 255, 125]);
      const fixture = await makeFixture(async (input, init) => {
        expect(String(input)).toBe(`https://api.x.ai${pathname}`);
        expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(requestBytes);
        return Response.json({ request_id: `${capability}-job` });
      });

      const response = await profileRequest(
        fixture,
        "grok.trustedtunnel.app",
        pathname,
        "POST",
        { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
        requestBytes
      );

      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(fixture.db.videoJobs[0]).toMatchObject({
        user_id: "user_grok",
        status: "pending",
        capability
      });
      expect(fixture.db.mediaStartedByCapability.get(capability)).toBe(1);
      await fixture.ctx.flush();
      expect(fixture.db.audit.at(-1)).toMatchObject({
        route_profile_id: planId,
        route: pathname,
        status: "ok",
        upstream_status: 200
      });
    }
  );

  it("polls an owned video with a freshly resolved slot and finalizes media usage once", async () => {
    const providerId = "d97415a1-5796-b7ec-379f-4e6819e08fdf";
    const doneBytes = new TextEncoder().encode(JSON.stringify({
      status: "done",
      video: {
        url: "https://vidgen.x.ai/temporary/video.mp4",
        duration: 6,
        file_output: { file_id: "file_video-output" }
      },
      model: "grok-imagine-video",
      usage: { cost_in_usd_ticks: 500000000 }
    }));
    const fixture = await makeFixture(async (input, init) => {
      if (String(input).endsWith("/v1/videos/generations")) {
        return Response.json({ request_id: providerId });
      }
      expect(String(input)).toBe(`https://api.x.ai/v1/videos/${providerId}`);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("Authorization"))
        .toBe("Bearer grok-production-provider-secret");
      return new Response(doneBytes, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const start = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/videos/generations",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      "{}"
    );
    expect(start.status).toBe(200);
    await start.arrayBuffer();
    expect(fixture.slotResolveCount()).toBe(1);

    for (let index = 0; index < 2; index += 1) {
      const poll = await profileRequest(
        fixture,
        "grok.trustedtunnel.app",
        `/v1/videos/${providerId}`,
        "GET",
        { Authorization: `Bearer ${MINI_KEY}` }
      );
      expect(poll.status).toBe(200);
      expect(new Uint8Array(await poll.arrayBuffer())).toEqual(doneBytes);
    }
    expect(fixture.slotResolveCount()).toBe(3);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(3);
    expect(fixture.db.videoJobs[0]).toMatchObject({
      status: "done",
      video_seconds: 6,
      outputs: 1,
      provider_cost_usd_ticks: 500000000
    });
    expect(fixture.db.mediaCompletedJobs).toBe(1);
    expect(fixture.db.mediaVideoSeconds).toBe(6);
    expect(fixture.db.mediaOutputs).toBe(1);
    expect(fixture.db.mediaProviderCostTicks).toBe(500000000);
    expect(fixture.db.mediaCostMeasurements).toBe(1);
    expect(fixture.db.fileOwners).toHaveLength(1);
    expect(fixture.db.fileOwners[0]).toMatchObject({
      user_id: "user_grok",
      source: "video_output"
    });
  });

  it("fails a completed video poll before replay when file ownership cannot bind", async () => {
    const providerId = "d97415a1-5796-b7ec-379f-4e6819e08fdf";
    const fixture = await makeFixture(async (input) => {
      if (String(input).endsWith("/v1/videos/generations")) {
        return Response.json({ request_id: providerId });
      }
      return Response.json({
        status: "done",
        video: {
          url: "https://vidgen.x.ai/temporary/video.mp4",
          duration: 2,
          file_output: { file_id: "file_unbound-video" }
        },
        model: "grok-imagine-video"
      });
    });
    const start = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/videos/generations",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      "{}"
    );
    await start.arrayBuffer();
    await fixture.ctx.flush();
    fixture.db.failFileOwnerInsert = true;

    const poll = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      `/v1/videos/${providerId}`,
      "GET",
      { Authorization: `Bearer ${MINI_KEY}` }
    );

    await expectOpenAIError(poll, 502, "xai_file_binding_failed");
    await fixture.ctx.flush();
    expect(fixture.db.audit.at(-1)).toMatchObject({
      route_profile_id: "grok.production.videos_poll",
      status: "error",
      upstream_status: 200,
      error_code: "xai_file_binding_failed"
    });
    expect(fixture.db.subscriptionLastSuccessAt).toBe("2026-07-23T00:00:00.000Z");
  });

  it("rejects an unowned video poll before resolving credentials or fetching upstream", async () => {
    const fixture = await makeFixture(vi.fn());
    fixture.db.seedUser("another_user");
    fixture.db.seedVideoJob({
      request_id_hash: await hmacSha256Hex("pepper-secret", "video-job:v1:other-user-job"),
      user_id: "another_user",
      route_profile_id: "grok.production.videos_poll",
      capability: "video_generation",
      status: "pending",
      video_seconds: null,
      outputs: null,
      provider_cost_usd_ticks: null,
      created_at: "2026-07-23T00:00:00.000Z",
      updated_at: "2026-07-23T00:00:00.000Z",
      terminal_at: null,
      usage_finalized_at: null
    });

    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/videos/other-user-job",
      "GET",
      { Authorization: `Bearer ${MINI_KEY}` }
    );
    await expectOpenAIError(response, 404, "video_job_not_found");
    expect(fixture.slotResolveCount()).toBe(0);
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown video poll before resolving credentials or fetching upstream", async () => {
    const fixture = await makeFixture(vi.fn());
    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/videos/unknown-job",
      "GET",
      { Authorization: `Bearer ${MINI_KEY}` }
    );
    await expectOpenAIError(response, 404, "video_job_not_found");
    expect(fixture.slotResolveCount()).toBe(0);
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it.each(["failed", "expired"] as const)(
    "finalizes a %s video without output usage",
    async (terminalStatus) => {
      const providerId = `${terminalStatus}-job`;
      const fixture = await makeFixture(async (input) => {
        if (String(input).endsWith("/v1/videos/generations")) {
          return Response.json({ request_id: providerId });
        }
        return Response.json({ status: terminalStatus });
      });
      const start = await profileRequest(
        fixture,
        "grok.trustedtunnel.app",
        "/v1/videos/generations",
        "POST",
        { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
        "{}"
      );
      expect(start.status).toBe(200);
      await start.arrayBuffer();
      const poll = await profileRequest(
        fixture,
        "grok.trustedtunnel.app",
        `/v1/videos/${providerId}`,
        "GET",
        { Authorization: `Bearer ${MINI_KEY}` }
      );
      expect(poll.status).toBe(200);
      await poll.arrayBuffer();
      expect(fixture.db.mediaFailedJobs).toBe(terminalStatus === "failed" ? 1 : 0);
      expect(fixture.db.mediaExpiredJobs).toBe(terminalStatus === "expired" ? 1 : 0);
      expect(fixture.db.mediaOutputs).toBe(0);
      expect(fixture.db.mediaVideoSeconds).toBe(0);
    }
  );

  it("does not infer output or duration from an incomplete done response", async () => {
    const providerId = "incomplete-done-job";
    const fixture = await makeFixture(async (input) => {
      if (String(input).endsWith("/v1/videos/generations")) {
        return Response.json({ request_id: providerId });
      }
      return Response.json({ status: "done", video: {} });
    });
    const start = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/videos/generations",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      "{}"
    );
    await start.arrayBuffer();
    const poll = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      `/v1/videos/${providerId}`,
      "GET",
      { Authorization: `Bearer ${MINI_KEY}` }
    );
    await poll.arrayBuffer();
    expect(fixture.db.videoJobs[0]).toMatchObject({
      status: "done",
      video_seconds: null,
      outputs: null
    });
    expect(fixture.db.mediaCompletedJobs).toBe(1);
    expect(fixture.db.mediaOutputs).toBe(0);
    expect(fixture.db.mediaVideoSeconds).toBe(0);
  });

  it("fails closed when a successful video start cannot be owner-bound", async () => {
    const fixture = await makeFixture(async () => Response.json({ unexpected: "shape" }));
    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/videos/generations",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      "{}"
    );
    await expectOpenAIError(response, 502, "video_start_response_invalid");
    expect(fixture.db.videoJobs).toHaveLength(0);
    expect(fixture.db.mediaStartedJobs).toBe(0);
    await fixture.ctx.flush();
    expect(fixture.db.audit.at(-1)).toMatchObject({
      route_profile_id: "grok.production.videos_generations",
      status: "error",
      upstream_status: 200,
      error_code: "video_start_response_invalid"
    });
  });

  it("bounds video control responses without imposing a generation request-body limit", async () => {
    const oversized = new Uint8Array(64 * 1024 + 1);
    const fixture = await makeFixture(async (_input, init) => {
      expect((await new Response(init?.body).arrayBuffer()).byteLength).toBe(1024 * 1024);
      return new Response(oversized, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const requestChunk = new Uint8Array(1024 * 1024);
    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/videos/generations",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      requestChunk
    );
    await expectOpenAIError(response, 502, "provider_control_response_too_large");
    expect(fixture.db.videoJobs).toHaveLength(0);
    await fixture.ctx.flush();
    expect(fixture.db.audit.at(-1)).toMatchObject({
      route_profile_id: "grok.production.videos_generations",
      status: "error",
      error_code: "provider_control_response_too_large"
    });
  });

  it("rejects a video redirect after exactly one upstream attempt", async () => {
    const fixture = await makeFixture(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://unexpected.example/video" }
    }));
    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/videos/generations",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      "{}"
    );
    await expectOpenAIError(response, 502, "upstream_redirect_rejected");
    await fixture.ctx.flush();
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.db.videoJobs).toHaveLength(0);
    expect(fixture.db.audit.at(-1)).toMatchObject({
      route_profile_id: "grok.production.videos_generations",
      status: "error",
      upstream_status: 302,
      error_code: "upstream_redirect_rejected"
    });
  });

  it("propagates video start cancellation after exactly one upstream attempt", async () => {
    let upstreamSignal: AbortSignal | null = null;
    const fixture = await makeFixture(async (_input, init) => {
      upstreamSignal = init?.signal ?? null;
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new Error("aborted"));
        if (init?.signal?.aborted) {
          abort();
        } else {
          init?.signal?.addEventListener("abort", abort, { once: true });
        }
      });
    });
    const controller = new AbortController();
    const pending = handleRequest(new Request(
      "https://grok.trustedtunnel.app/v1/videos/generations",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MINI_KEY}`,
          "Content-Type": "application/json"
        },
        body: "{}",
        signal: controller.signal
      }
    ), fixture.env, fixture.ctx, fixture.deps);
    await vi.waitFor(() => expect(fixture.fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    const response = await pending;
    await expectOpenAIError(response, 499, "client_request_aborted");
    await fixture.ctx.flush();
    expect((upstreamSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.db.videoJobs).toHaveLength(0);
    expect(fixture.db.audit.at(-1)).toMatchObject({
      route_profile_id: "grok.production.videos_generations",
      status: "error",
      error_code: "client_request_aborted"
    });
  });

  it("does not change successful poll bytes when lifecycle observation fails", async () => {
    const providerId = "observation-failure-job";
    const doneBytes = new TextEncoder().encode(
      "{\"status\":\"done\",\"video\":{\"duration\":6,\"url\":\"https://vidgen.x.ai/video.mp4\"}}"
    );
    const fixture = await makeFixture(async (input) => {
      if (String(input).endsWith("/v1/videos/generations")) {
        return Response.json({ request_id: providerId });
      }
      return new Response(doneBytes, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const start = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/videos/generations",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      "{}"
    );
    expect(start.status).toBe(200);
    await start.arrayBuffer();
    fixture.db.failVideoObservation = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const poll = await profileRequest(
        fixture,
        "grok.trustedtunnel.app",
        `/v1/videos/${providerId}`,
        "GET",
        { Authorization: `Bearer ${MINI_KEY}` }
      );
      expect(poll.status).toBe(200);
      expect(new Uint8Array(await poll.arrayBuffer())).toEqual(doneBytes);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("video_job_observation_failed"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("passes the original Grok request stream to upstream without consuming it", async () => {
    const requestBytes = new Uint8Array([0, 255, 123, 110, 111, 116, 45, 106, 115, 111, 110]);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(requestBytes);
        controller.close();
      }
    });
    let request: Request;
    let bodyUsedAtFetch = true;
    let forwardedBody: BodyInit | null | undefined;
    const fixture = await makeFixture(async (_input, init) => {
      bodyUsedAtFetch = request.bodyUsed;
      forwardedBody = init?.body;
      return new Response("opaque-upstream", { status: 200 });
    }, ["surface:grok:production"]);
    request = new Request("https://grok.trustedtunnel.app/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MINI_KEY}`,
        "Content-Type": "application/octet-stream"
      },
      body,
      duplex: "half"
    } as RequestInit);

    const response = await handleRequest(request, fixture.env, fixture.ctx, fixture.deps);
    expect(response.status).toBe(200);
    expect(bodyUsedAtFetch).toBe(false);
    expect(forwardedBody).toBe(request.body);
    expect(pulls).toBe(1);
  });

  it.each([
    { name: "Gemini carrier", headers: new Headers({ "x-goog-api-key": MINI_KEY }) },
    { name: "Anthropic carrier", headers: new Headers({ "x-api-key": MINI_KEY }) }
  ])("rejects $name before D1", async ({ headers }) => {
    const fixture = await makeFixture(vi.fn(), ["surface:grok:production"]);
    const response = await profileRequest(
      fixture,
      "grok.trustedtunnel.app",
      "/v1/models",
      "GET",
      headers
    );
    await expectOpenAIError(response, 401, "missing_bearer_token");
    expect(fixture.db.authLookupCount).toBe(0);
  });

  it.each(["/v1/responses/compact"])(
    "rejects undeclared path %s with no upstream attempt",
    async (path) => {
      const fixture = await makeFixture(vi.fn(), ["surface:grok:production"]);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const response = await profileRequest(
          fixture,
          "grok.trustedtunnel.app",
          path,
          "POST",
          { Authorization: `Bearer ${MINI_KEY}` },
          "{}"
        );
        await expectOpenAIError(response, 404, "not_found");
        expect(fixture.fetchMock).not.toHaveBeenCalled();
        expect(fixture.db.audit).toHaveLength(0);
      } finally {
        logSpy.mockRestore();
      }
    }
  );

});

describe("xAI API admin surface", () => {
  it("observes provider usage on the exact Responses plan after unchanged bytes are drained", async () => {
    const upstreamBytes = new TextEncoder().encode(JSON.stringify({
      id: "resp_xai_metered",
      object: "response",
      status: "completed",
      model: "grok-4.5",
      usage: {
        input_tokens: 7,
        output_tokens: 5,
        total_tokens: 12,
        cost_in_usd_ticks: 5944000
      }
    }));
    const fixture = await makeFixture(async (input, init) => {
      expect(String(input)).toBe("https://api.x.ai/v1/responses");
      expect(new Headers(init?.headers).get("Authorization"))
        .toBe("Bearer grok-production-provider-secret");
      return new Response(upstreamBytes, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }, ["surface:xai:production"]);

    const response = await profileRequest(
      fixture,
      "xai.trustedtunnel.app",
      "/v1/responses",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      "{}"
    );

    expect(response.status).toBe(200);
    expect(fixture.db.audit).toHaveLength(0);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(upstreamBytes);
    await fixture.ctx.flush();
    expect(fixture.db.audit).toEqual([expect.objectContaining({
      route_profile_id: "xai.production.responses",
      status: "ok",
      upstream_status: 200,
      response_model: "grok-4.5",
      provider_cost_usd_ticks: 5944000
    })]);
    expect(fixture.db.usageDaily).toEqual([expect.objectContaining({
      route_profile_id: "xai.production.responses",
      response_model: "grok-4.5",
      total_tokens: 12,
      token_measurements: 1,
      provider_cost_usd_ticks: 5944000,
      cost_measurements: 1
    })]);
  });

  it("keeps total-token coverage unknown when a provider supplies only partial token fields", async () => {
    const upstreamBytes = new TextEncoder().encode(JSON.stringify({
      id: "resp_xai_partial_metering",
      object: "response",
      status: "completed",
      model: "grok-4.5",
      usage: {
        input_tokens: 7,
        cost_in_usd_ticks: 0
      }
    }));
    const fixture = await makeFixture(async () => new Response(upstreamBytes, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }), ["surface:xai:production"]);

    const response = await profileRequest(
      fixture,
      "xai.trustedtunnel.app",
      "/v1/responses",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      "{}"
    );

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(upstreamBytes);
    await fixture.ctx.flush();
    expect(fixture.db.usageDaily).toEqual([expect.objectContaining({
      route_profile_id: "xai.production.responses",
      input_tokens: 7,
      total_tokens: 0,
      token_measurements: 0,
      provider_cost_usd_ticks: 0,
      cost_measurements: 1
    })]);
  });

  it("observes image metering without projecting Grok owner binding", async () => {
    const upstreamBytes = new TextEncoder().encode(JSON.stringify({
      data: [{
        url: "https://imgen.x.ai/temporary/admin-image.jpg",
        file_output: { file_id: "file_admin-image" }
      }],
      usage: { cost_in_usd_ticks: 500000000 }
    }));
    const fixture = await makeFixture(async () => new Response(upstreamBytes, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }), ["surface:xai:production"]);

    const response = await profileRequest(
      fixture,
      "xai.trustedtunnel.app",
      "/v1/images/generations",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      "{}"
    );

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(upstreamBytes);
    await fixture.ctx.flush();
    expect(fixture.db.fileOwners).toHaveLength(0);
    expect(fixture.db.audit.at(-1)).toMatchObject({
      route_profile_id: "xai.production.images_generations",
      status: "ok",
      upstream_status: 200
    });
    expect(fixture.db.imageMediaUsage).toEqual([expect.objectContaining({
      route_profile_id: "xai.production.images_generations",
      capability: "image_generation",
      completed_jobs: 1,
      outputs: 1,
      output_measurements: 1,
      provider_cost_usd_ticks: 500000000,
      cost_measurements: 1
    })]);
  });

  it("observes xAI video lifecycle metering without making the audit path owner-bound", async () => {
    const providerId = "admin-video-job";
    const startBytes = new TextEncoder().encode(JSON.stringify({ request_id: providerId }));
    const doneBytes = new TextEncoder().encode(JSON.stringify({
      status: "done",
      model: "grok-imagine-video",
      video: {
        url: "https://vidgen.x.ai/temporary/admin-video.mp4",
        duration: 4,
        file_output: { file_id: "file_admin-video" }
      },
      usage: { cost_in_usd_ticks: 700000000 }
    }));
    const fixture = await makeFixture(async (input) => String(input).endsWith("/v1/videos/generations")
      ? new Response(startBytes, { headers: { "Content-Type": "application/json" } })
      : new Response(doneBytes, { headers: { "Content-Type": "application/json" } }),
    ["surface:xai:production"]);

    const start = await profileRequest(
      fixture,
      "xai.trustedtunnel.app",
      "/v1/videos/generations",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
      "{}"
    );
    expect(fixture.db.videoJobs).toHaveLength(0);
    expect(new Uint8Array(await start.arrayBuffer())).toEqual(startBytes);
    await fixture.ctx.flush();
    expect(fixture.db.videoJobs).toEqual([expect.objectContaining({
      user_id: "user_grok",
      route_profile_id: "xai.production.videos_generations",
      capability: "video_generation",
      status: "pending"
    })]);

    const poll = await profileRequest(
      fixture,
      "xai.trustedtunnel.app",
      `/v1/videos/${providerId}`,
      "GET",
      { Authorization: `Bearer ${MINI_KEY}` }
    );
    expect(new Uint8Array(await poll.arrayBuffer())).toEqual(doneBytes);
    await fixture.ctx.flush();
    expect(fixture.db.videoJobs[0]).toMatchObject({
      status: "done",
      video_seconds: 4,
      outputs: 1,
      provider_cost_usd_ticks: 700000000
    });
    expect(fixture.db.mediaCompletedJobs).toBe(1);
    expect(fixture.db.mediaVideoSeconds).toBe(4);
    expect(fixture.db.mediaOutputs).toBe(1);
    expect(fixture.db.mediaProviderCostTicks).toBe(700000000);
    expect(fixture.db.mediaCostMeasurements).toBe(1);
    expect(fixture.db.fileOwners).toHaveLength(0);
    expect(fixture.db.audit.map((row) => row.route_profile_id)).toEqual([
      "xai.production.videos_generations",
      "xai.production.video"
    ]);
  });

  it("records successful but untrackable xAI video starts as unmeasured lifecycle coverage", async () => {
    const bodies = [
      new TextEncoder().encode(JSON.stringify({ unexpected: "shape" })),
      new Uint8Array(64 * 1024 + 1)
    ];

    for (const upstreamBytes of bodies) {
      const fixture = await makeFixture(async () => new Response(upstreamBytes, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }), ["surface:xai:production"]);
      const response = await profileRequest(
        fixture,
        "xai.trustedtunnel.app",
        "/v1/videos/generations",
        "POST",
        { Authorization: `Bearer ${MINI_KEY}`, "Content-Type": "application/json" },
        "{}"
      );

      expect(new Uint8Array(await response.arrayBuffer())).toEqual(upstreamBytes);
      await fixture.ctx.flush();
      expect(fixture.db.videoJobs).toHaveLength(0);
      expect(fixture.db.imageMediaUsage).toEqual([expect.objectContaining({
        route_profile_id: "xai.production.videos_generations",
        capability: "video_generation",
        started_jobs: 1,
        completed_jobs: 0,
        failed_jobs: 0,
        cost_measurements: 0
      })]);
    }
  });

  it("requires the explicit xAI grant and forwards compact opaquely through the shared Grok slot", async () => {
    const requestBytes = new Uint8Array([123, 34, 105, 110, 112, 117, 116, 34, 58, 255, 125]);
    const responseBytes = new Uint8Array([123, 34, 116, 121, 112, 101, 34, 58, 34, 99, 111, 109, 112, 97, 99, 116, 105, 111, 110, 34, 125]);
    const allowed = await makeFixture(async (input, init) => {
      expect(String(input)).toBe("https://api.x.ai/v1/responses/compact?future=1");
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(requestBytes);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer grok-production-provider-secret");
      expect(headers.get("x-xai-token-auth")).toBeNull();
      expect(headers.get("x-grok-client-version")).toBeNull();
      expect(headers.get("x-grok-client-mode")).toBeNull();
      return new Response(responseBytes, {
        status: 202,
        headers: {
          "Content-Type": "application/octet-stream",
          "x-provider-control": "preserve"
        }
      });
    }, ["surface:xai:production"]);

    const response = await profileRequest(
      allowed,
      "xai.trustedtunnel.app",
      "/v1/responses/compact?future=1",
      "POST",
      {
        Authorization: `Bearer ${MINI_KEY}`,
        "Content-Type": "application/octet-stream",
        "x-xai-token-auth": "caller-must-not-pass",
        "x-grok-client-version": "caller-must-not-pass",
        "x-grok-client-mode": "caller-must-not-pass"
      },
      requestBytes
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("x-provider-control")).toBe("preserve");
    // xAI admin audit is header-based so the upstream body remains a true
    // compression-safe passthrough rather than an observed stream.
    await allowed.ctx.flush();
    expect(allowed.db.audit).toHaveLength(1);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(responseBytes);
    expect(allowed.slotResolveCount()).toBe(1);
    expect(allowed.fetchMock).toHaveBeenCalledTimes(1);
    expect(allowed.db.audit[0]).toMatchObject({
      route_profile_id: "xai.production.responses_compact",
      route: "/v1/responses/compact",
      status: "ok",
      upstream_status: 202,
      capability_source: "grok",
      ingress_protocol: "xai/api",
      response_model: "N/A",
      total_tokens: null
    });
    expect(allowed.db.usageWrites).toBe(0);

    const denied = await makeFixture(vi.fn(), ["surface:grok:production"]);
    const deniedResponse = await profileRequest(
      denied,
      "xai.trustedtunnel.app",
      "/v1/responses/compact",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}` },
      "{}"
    );
    await expectOpenAIError(deniedResponse, 403, "scope_denied");
    expect(denied.slotResolveCount()).toBe(0);
    expect(denied.fetchMock).not.toHaveBeenCalled();
  });

  it("keeps Realtime ephemeral secrets and WebSocket authority behind the explicit admin grant", async () => {
    const allowed = await makeFixture(async (input, init) => {
      expect(String(input)).toBe("https://api.x.ai/v1/realtime/client_secrets");
      expect(new Headers(init?.headers).get("Authorization"))
        .toBe("Bearer grok-production-provider-secret");
      return Response.json({ value: "fixture-ephemeral-secret", expires_at: 1_786_000_000 });
    }, ["surface:xai:production"]);
    const response = await profileRequest(
      allowed,
      "xai.trustedtunnel.app",
      "/v1/realtime/client_secrets",
      "POST",
      { Authorization: `Bearer ${MINI_KEY}` },
      "{}"
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      value: "fixture-ephemeral-secret",
      expires_at: 1_786_000_000
    });
    await allowed.ctx.flush();
    expect(allowed.db.audit).toHaveLength(1);
    expect(allowed.db.audit[0]).toMatchObject({
      route_profile_id: "xai.production.realtime_client_secrets",
      route: "/v1/realtime/client_secrets",
      status: "ok",
      upstream_status: 200,
      capability_source: "grok",
      ingress_protocol: "xai/api",
      total_tokens: null
    });

    const denied = await makeFixture(vi.fn(), ["surface:grok:production"]);
    for (const request of [
      new Request("https://xai.trustedtunnel.app/v1/realtime/client_secrets", {
        method: "POST",
        headers: { Authorization: `Bearer ${MINI_KEY}` },
        body: "{}"
      }),
      new Request("https://xai.trustedtunnel.app/v1/realtime", {
        headers: {
          Authorization: `Bearer ${MINI_KEY}`,
          Upgrade: "websocket",
          Connection: "Upgrade"
        }
      })
    ]) {
      const deniedResponse = await handleRequest(
        request,
        denied.env,
        denied.ctx,
        denied.deps
      );
      await expectOpenAIError(deniedResponse, 403, "scope_denied");
    }
    expect(denied.slotResolveCount()).toBe(0);
    expect(denied.fetchMock).not.toHaveBeenCalled();
  });
});

describe("Grok and xAI Responses header completion", () => {
  it.each([
    {
      hostname: "grok.trustedtunnel.app",
      grant: "surface:grok:production",
      upstream: "https://cli-chat-proxy.grok.com/v1/responses"
    },
    {
      hostname: "xai.trustedtunnel.app",
      grant: "surface:xai:production",
      upstream: "https://api.x.ai/v1/responses"
    }
  ])("completes missing SSE Content-Type for $hostname", async ({ hostname, grant, upstream }) => {
    const responseBytes = new TextEncoder().encode("data: [DONE]\n\n");
    const fixture = await makeFixture(async (input) => {
      expect(String(input)).toBe(upstream);
      return new Response(responseBytes, { status: 200 });
    }, [grant]);

    const response = await profileRequest(
      fixture,
      hostname,
      "/v1/responses",
      "POST",
      {
        Authorization: `Bearer ${MINI_KEY}`,
        Accept: "text/event-stream",
        "Content-Type": "application/json"
      },
      "{}"
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(responseBytes);
    await fixture.ctx.flush();
  });
});

async function expectOpenAIError(
  response: Response,
  status: number,
  code: string
): Promise<void> {
  expect(response.status).toBe(status);
  const body = await response.json() as { error: { code: string } };
  expect(body.error.code).toBe(code);
  expect(response.headers.get("x-request-id") ?? response.headers.get("X-Mini-Route-Policy-Trace-Id"))
    .toMatch(UUID_V4);
}

async function profileRequest(
  fixture: Fixture,
  host: string,
  path: string,
  method: string,
  headers: HeadersInit,
  body?: BodyInit
): Promise<Response> {
  return handleRequest(new Request(`https://${host}${path}`, {
    method,
    headers,
    body
  }), fixture.env, fixture.ctx, fixture.deps);
}

interface Fixture {
  env: Env;
  deps: ExecutionDependencies;
  ctx: FakeExecutionContext;
  db: RouteProfileDatabase;
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  slotResolveCount: () => number;
}


async function makeFixture(
  fetchImpl: typeof fetch,
  scopes = ["surface:grok:production"],
  options: { seedGrok?: boolean } = {}
): Promise<Fixture> {
  const seedGrok = options.seedGrok !== false;
  const now = "2026-07-23T00:00:00.000Z";
  const db = new RouteProfileDatabase({
    apiKey: {
      id: "key_grok",
      user_id: "user_grok",
      key_prefix: keyPrefix(MINI_KEY),
      key_hash: await hmacSha256Hex("pepper-secret", MINI_KEY),
      status: "active",
      scopes: JSON.stringify(scopes),
      expires_at: null,
      last_used_at: now,
      created_at: now,
      revoked_at: null
    },
    user: {
      id: "user_grok",
      email: "grok@example.com",
      status: "active",
      created_at: now,
      updated_at: now
    }
  });
  onTestFinished(() => db.close());
  const fetchMock = vi.fn(fetchImpl);
  const subscriptionByName = new Map<string, { credential?: Record<string, unknown> }>();
  let currentName = "shared_default";
  let grokSlotResolutions = 0;
  const authority = {
    async saveToken() {},
    async getFreshAccessToken() {
      return { ok: true as const, value: { access_token: "chatgpt-access" } };
    },
    async refreshNow() {
      return { ok: true as const, value: { auth_id: "shared_default", refresh_available: true } };
    },
    async revoke() {},
    async saveSubscriptionCredential(credential: Record<string, unknown>) {
      subscriptionByName.set(currentName, { credential: { ...credential } });
      return { ok: true as const, value: null };
    },
    async getFreshSubscriptionCredential() {
      grokSlotResolutions += 1;
      const slot = subscriptionByName.get(currentName);
      if (!slot?.credential) {
        const { HttpError } = await import("../../src/errors");
        throw new HttpError(401, "missing", "authentication_error", "missing_subscription_credential");
      }
      return {
        ok: true as const,
        value: { access_token: String(slot.credential.access_token) }
      };
    },
    async refreshSubscriptionNow() {
      return { ok: true as const, value: { account_id: "x", refresh_available: false } };
    },
    async revokeSubscription() {}
  };
  if (seedGrok) {
    for (const [id, environment, token] of [
      ["sub_grok_prod", "production", "grok-production-provider-secret"]
    ] as const) {
      db.seedSubscriptionAccount({
        id,
        capability_source: "grok",
        environment,
        label: `grok-${environment}`,
        status: "active",
        provider_account_ref: null,
        expires_at: "2099-01-01T00:00:00.000Z",
        refresh_available: 1,
        last_refresh_at: null,
        reauth_required_at: null,
        last_success_at: null,
        last_failure_at: null,
        last_test_at: null,
        last_test_status: null,
        created_at: now,
        updated_at: now
      });
      currentName = `subscription:${id}`;
      await authority.saveSubscriptionCredential({
        account_id: id,
        capability_source: "grok",
        access_token: token,
        refresh_token: "refresh",
        expires_at: "2099-01-01T00:00:00.000Z",
        status: "active"
      });
    }
  }
  for (const scope of scopes.filter((value) => value === "surface:grok:production" || value === "surface:xai:production")) {
    db.sqlite.prepare(
      `INSERT INTO api_key_surface_credentials
         (api_key_id, surface_grant, codex_auth_id, subscription_account_id, created_at, updated_at)
       VALUES ('key_grok', ?, NULL, 'sub_grok_prod', ?, ?)`
    ).run(scope, now, now);
  }
  const env = {
    DB: db.binding,
    TOKEN_AUTHORITY: {
      idFromName(name: string) {
        return { toString: () => name, equals: () => false, name };
      },
      get(id: { toString(): string }) {
        currentName = id.toString();
        return authority;
      }
    } as unknown as Env["TOKEN_AUTHORITY"],
    TOKEN_ENCRYPTION_KEY_V1: "encryption-secret",
    API_KEY_HASH_PEPPER: "pepper-secret",
    ADMIN_SECRET: "admin-secret",
    CODEX_EGRESS_BASE_URL: "https://codex-egress-us-west1-a.trustedtunnel.app",
    CODEX_EGRESS_SECRET: "codex-egress-secret",
    CODEX_OAUTH_TOKEN_URL: "https://auth.example.test/token",
    CODEX_CLIENT_ID: "client",
    REQUEST_AUDIT_RETENTION_DAYS: "30"
  } as unknown as Env;
  return {
    env,
    db,
    fetchMock,
    ctx: new FakeExecutionContext(),
    deps: {
      fetch: fetchMock,
      now: () => new Date(now)
    },
    slotResolveCount: () => grokSlotResolutions
  };
}

class FakeExecutionContext {
  private readonly promises: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>): void {
    this.promises.push(promise);
  }
  async flush(): Promise<void> {
    await Promise.all(this.promises);
  }
}

class RouteProfileDatabase {
  readonly binding: D1Database;
  readonly sqlite: DatabaseSync;
  private readonly testDb: TestD1;
  authLookupCount = 0;

  constructor(rows: {
    apiKey: Record<string, unknown>;
    user: Record<string, unknown>;
  }) {
    this.testDb = createTestD1({
      onPrepare: (sql) => {
        if (sql.includes("FROM api_keys AS ak")) {
          this.authLookupCount += 1;
        }
      }
    });
    this.binding = this.testDb.binding;
    this.sqlite = this.testDb.sqlite;
    seedIdentityVersions(this.sqlite);
    this.sqlite.prepare(
      "UPDATE organization_surface_credit_defaults SET monthly_allowance = 1000000"
    ).run();
    this.sqlite.prepare(
      `INSERT INTO users (id, email, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(...sqliteValues(
      rows.user.id,
      rows.user.email,
      rows.user.status,
      rows.user.created_at,
      rows.user.updated_at
    ));
    this.sqlite.prepare(
      `INSERT INTO api_keys
         (id, user_id, key_prefix, key_hash, status, scopes, expires_at,
          last_used_at, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...sqliteValues(
      rows.apiKey.id,
      rows.apiKey.user_id,
      rows.apiKey.key_prefix,
      rows.apiKey.key_hash,
      rows.apiKey.status,
      rows.apiKey.scopes,
      rows.apiKey.expires_at,
      rows.apiKey.last_used_at,
      rows.apiKey.created_at,
      rows.apiKey.revoked_at
    ));
  }

  close(): void {
    this.testDb.close();
  }

  get audit(): Array<Record<string, unknown>> {
    return this.rows("request_audit");
  }

  get usageDaily(): Array<Record<string, unknown>> {
    return this.rows("usage_daily");
  }

  get usageWrites(): number {
    return this.usageDaily.length;
  }

  get videoJobs(): Array<Record<string, unknown>> {
    return this.rows("video_jobs");
  }

  get fileOwners(): Array<Record<string, unknown>> {
    return this.rows("xai_file_owners");
  }

  get imageMediaUsage(): Array<Record<string, unknown>> {
    return this.rows("media_usage_daily");
  }

  get mediaStartedJobs(): number {
    return this.mediaTotal("started_jobs");
  }

  get mediaStartedByCapability(): Map<string, number> {
    return new Map(this.sqlite.prepare(
      `SELECT capability, SUM(started_jobs) AS value
       FROM media_usage_daily GROUP BY capability`
    ).all().map((row) => [String(row.capability), Number(row.value)]));
  }

  get mediaCompletedJobs(): number {
    return this.mediaTotal("completed_jobs");
  }

  get mediaFailedJobs(): number {
    return this.mediaTotal("failed_jobs");
  }

  get mediaExpiredJobs(): number {
    return this.mediaTotal("expired_jobs");
  }

  get mediaVideoSeconds(): number {
    return this.mediaTotal("video_seconds");
  }

  get mediaOutputs(): number {
    return this.mediaTotal("outputs");
  }

  get mediaProviderCostTicks(): number {
    return this.mediaTotal("provider_cost_usd_ticks");
  }

  get mediaCostMeasurements(): number {
    return this.mediaTotal("cost_measurements");
  }

  get subscriptionLastSuccessAt(): string | null {
    const row = this.sqlite.prepare(
      "SELECT last_success_at FROM subscription_accounts WHERE id = 'sub_grok_prod'"
    ).get() as { last_success_at: string | null } | undefined;
    return row?.last_success_at ?? null;
  }

  async bindFileOwner(fileId: string, userId: string, source: string): Promise<void> {
    this.sqlite.prepare(
      `INSERT INTO xai_file_owners
         (file_id_hash, user_id, source, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)`
    ).run(
      await hmacSha256Hex("pepper-secret", `xai-file:v1:${fileId}`),
      userId,
      source,
      "2026-07-23T00:00:00.000Z",
      "2026-07-23T00:00:00.000Z"
    );
  }

  seedSubscriptionAccount(row: Record<string, unknown>): void {
    this.sqlite.prepare(
      `INSERT INTO subscription_accounts
         (id, capability_source, environment, label, status, provider_account_ref,
          expires_at, refresh_available, last_refresh_at, reauth_required_at,
          last_success_at, last_failure_at, last_test_at, last_test_status,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...sqliteValues(
      row.id, row.capability_source, row.environment, row.label, row.status,
      row.provider_account_ref, row.expires_at, row.refresh_available,
      row.last_refresh_at, row.reauth_required_at, row.last_success_at,
      row.last_failure_at, row.last_test_at, row.last_test_status,
      row.created_at, row.updated_at
    ));
  }

  seedVideoJob(row: Record<string, unknown>): void {
    this.sqlite.prepare(
      `INSERT INTO video_jobs
         (request_id_hash, user_id, route_profile_id, capability, status,
          video_seconds, outputs, provider_cost_usd_ticks, created_at, updated_at,
          terminal_at, usage_finalized_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...sqliteValues(
      row.request_id_hash, row.user_id, row.route_profile_id, row.capability,
      row.status, row.video_seconds, row.outputs, row.provider_cost_usd_ticks,
      row.created_at, row.updated_at, row.terminal_at, row.usage_finalized_at
    ));
  }

  seedUser(id: string): void {
    this.sqlite.prepare(
      `INSERT INTO users (id, email, status, created_at, updated_at)
       VALUES (?, NULL, 'active', ?, ?)`
    ).run(id, "2026-07-23T00:00:00.000Z", "2026-07-23T00:00:00.000Z");
  }

  set failFileOwnerInsert(enabled: boolean) {
    this.failureTrigger("fail_file_owner_insert", "BEFORE INSERT", "xai_file_owners", enabled);
  }

  set failFileOwnerDelete(enabled: boolean) {
    this.failureTrigger("fail_file_owner_delete", "BEFORE DELETE", "xai_file_owners", enabled);
  }

  set failVideoObservation(enabled: boolean) {
    this.failureTrigger("fail_video_observation", "BEFORE UPDATE", "video_jobs", enabled);
  }

  private failureTrigger(name: string, timing: string, table: string, enabled: boolean): void {
    this.sqlite.exec(`DROP TRIGGER IF EXISTS ${name}`);
    if (enabled) {
      this.sqlite.exec(
        `CREATE TRIGGER ${name} ${timing} ON ${table}
         BEGIN SELECT RAISE(FAIL, 'injected database failure'); END`
      );
    }
  }

  private rows(table: string): Array<Record<string, unknown>> {
    return this.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
  }

  private mediaTotal(column: string): number {
    const row = this.sqlite.prepare(
      `SELECT COALESCE(SUM(${column}), 0) AS value FROM media_usage_daily`
    ).get() as { value: number };
    return Number(row.value);
  }
}

function sqliteValues(...values: unknown[]): SQLInputValue[] {
  return values as SQLInputValue[];
}
