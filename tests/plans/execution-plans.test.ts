import { describe, expect, it } from "vitest";
import {
  ISSUABLE_SURFACE_GRANTS,
  REAL_TASK_EXECUTION_PLAN_IDS,
  executionPlanPresentation,
  listExecutionPlans,
  listHostnames,
  matchExecutionPlan,
  plansForHostname,
  publicExecutionPlanPath
} from "../../src/plans/execution-plans";

describe("Execution Plans", () => {
  it("declares an explicit xAI API surface over the existing Grok OAuth slot", () => {
    const plans = plansForHostname("xai.trustedtunnel.app");

    expect(plans).not.toBeNull();
    expect(ISSUABLE_SURFACE_GRANTS.has("surface:xai:production")).toBe(true);
    expect(plans).not.toHaveLength(0);
    for (const plan of plans ?? []) {
      expect(plan).toMatchObject({
        hostname: "xai.trustedtunnel.app",
        surfaceGrant: "surface:xai:production",
        credentialSlot: "grok_production",
        protocol: "xai/api",
        providerBaseUrl: "https://api.x.ai",
        supportStatus: "active"
      });
      expect(plan.mode).toBe(plan.upgrade === "websocket"
        ? "websocket_transparent"
        : "transparent");
    }
  });

  it("exposes only the endpoint-specific subscription-OAuth-proven xAI REST allowlist", () => {
    const plans = plansForHostname("xai.trustedtunnel.app") ?? [];
    expect(plans.map((plan) => [plan.id, plan.method, plan.auditPath])).toEqual([
      ["xai.production.models", "GET", "/v1/models"],
      ["xai.production.model", "GET", "/v1/models/{model_id}"],
      ["xai.production.language_models", "GET", "/v1/language-models"],
      ["xai.production.image_generation_models", "GET", "/v1/image-generation-models"],
      ["xai.production.video_generation_models", "GET", "/v1/video-generation-models"],
      ["xai.production.tts_voices", "GET", "/v1/tts/voices"],
      ["xai.production.language_model", "GET", "/v1/language-models/{model_id}"],
      ["xai.production.image_generation_model", "GET", "/v1/image-generation-models/{model_id}"],
      ["xai.production.video_generation_model", "GET", "/v1/video-generation-models/{model_id}"],
      ["xai.production.tts_voice", "GET", "/v1/tts/voices/{voice_id}"],
      ["xai.production.tokenize_text", "POST", "/v1/tokenize-text"],
      ["xai.production.chat_completions", "POST", "/v1/chat/completions"],
      ["xai.production.chat_deferred_completion", "GET", "/v1/chat/deferred-completion/{request_id}"],
      ["xai.production.tts", "POST", "/v1/tts"],
      ["xai.production.stt", "POST", "/v1/stt"],
      ["xai.production.responses", "POST", "/v1/responses"],
      ["xai.production.responses_compact", "POST", "/v1/responses/compact"],
      ["xai.production.response", "GET", "/v1/responses/{response_id}"],
      ["xai.production.response_delete", "DELETE", "/v1/responses/{response_id}"],
      ["xai.production.images_generations", "POST", "/v1/images/generations"],
      ["xai.production.images_edits", "POST", "/v1/images/edits"],
      ["xai.production.videos_generations", "POST", "/v1/videos/generations"],
      ["xai.production.videos_edits", "POST", "/v1/videos/edits"],
      ["xai.production.videos_extensions", "POST", "/v1/videos/extensions"],
      ["xai.production.video", "GET", "/v1/videos/{request_id}"],
      ["xai.production.files_upload", "POST", "/v1/files"],
      ["xai.production.files_list", "GET", "/v1/files"],
      ["xai.production.file", "GET", "/v1/files/{file_id}"],
      ["xai.production.file_content", "GET", "/v1/files/{file_id}/content"],
      ["xai.production.file_delete", "DELETE", "/v1/files/{file_id}"],
      ["xai.production.custom_voices", "GET", "/v1/custom-voices"],
      ["xai.production.batches", "GET", "/v1/batches"],
      ["xai.production.batches_create", "POST", "/v1/batches"],
      ["xai.production.batch", "GET", "/v1/batches/{batch_id}"],
      ["xai.production.batch_requests", "GET", "/v1/batches/{batch_id}/requests"],
      ["xai.production.batch_requests_add", "POST", "/v1/batches/{batch_id}/requests"],
      ["xai.production.batch_results", "GET", "/v1/batches/{batch_id}/results"],
      ["xai.production.batch_cancel", "POST", "/v1/batches/{batch_id}:cancel"],
      ["xai.production.file_public_url", "POST", "/v1/files/{file_id}/public-url"],
      ["xai.production.file_public_url_revoke", "POST", "/v1/files/{file_id}/public-url/revoke"],
      ["xai.production.documents_search", "POST", "/v1/documents/search"],
      ["xai.production.realtime_client_secrets", "POST", "/v1/realtime/client_secrets"],
      ["xai.production.responses_websocket", "GET", "/v1/responses"],
      ["xai.production.tts_websocket", "GET", "/v1/tts"],
      ["xai.production.stt_websocket", "GET", "/v1/stt"],
      ["xai.production.realtime_websocket", "GET", "/v1/realtime"]
    ]);
  });

  it("matches every declared xAI endpoint and rejects undeclared or nested-resource paths", () => {
    const plans = plansForHostname("xai.trustedtunnel.app") ?? [];
    for (const plan of plans) {
      const pathname = (plan.auditPath ?? "")
        .replace("{model_id}", "grok-fixture")
        .replace("{voice_id}", "voice-fixture")
        .replace("{request_id}", "request-fixture")
        .replace("{response_id}", "response-fixture")
        .replace("{file_id}", "opaque-provider-file-id")
        .replace("{batch_id}", "batch-fixture");
      expect(matchExecutionPlan(new Request(
        `https://xai.trustedtunnel.app${pathname}`,
        {
          method: plan.method,
          headers: plan.upgrade === "websocket" ? { Upgrade: "websocket" } : undefined
        }
      ), plans)).toMatchObject({ id: plan.id });
    }

    for (const [method, pathname] of [
      ["GET", "/v1/api-key"],
      ["POST", "/v1/custom-voices"],
      ["PUT", "/v1/files/file_fixture"],
      ["GET", "/v1/files/file_fixture/public-url"],
      ["GET", "/v1/models/a%2Fb"]
    ] as const) {
      expect(matchExecutionPlan(new Request(
        `https://xai.trustedtunnel.app${pathname}`,
        { method }
      ), plans)).toBeNull();
    }
  });

  it("charges no credit for catalog and non-task plans", () => {
    const plans = listExecutionPlans();

    expect(plans.filter((plan) => plan.creditCharge === 0).map((plan) => plan.id)).toEqual([
      "codex.models",
      "codex.responses_websocket",
      "grok.production.models",
      "grok.production.language_models",
      "grok.production.image_generation_models",
      "grok.production.video_generation_models",
      "grok.production.tts_voices",
      "grok.production.language_model",
      "grok.production.image_generation_model",
      "grok.production.video_generation_model",
      "grok.production.tts_voice",
      "xai.production.models",
      "xai.production.model",
      "xai.production.language_models",
      "xai.production.image_generation_models",
      "xai.production.video_generation_models",
      "xai.production.tts_voices",
      "xai.production.language_model",
      "xai.production.image_generation_model",
      "xai.production.video_generation_model",
      "xai.production.tts_voice",
      "xai.production.custom_voices"
    ]);
  });

  it("selects Provider client identity only for the five native HTTP plans", () => {
    expect(listExecutionPlans()
      .filter((plan) => plan.upstreamClientIdentity !== "none")
      .map((plan) => [plan.id, plan.upstreamClientIdentity])).toEqual([
      ["codex.models", "codex_cli"],
      ["codex.responses", "codex_cli"],
      ["codex.responses_compact", "codex_cli"],
      ["grok.production.models", "grok_build"],
      ["grok.production.responses", "grok_build"]
    ]);
  });

  it("declares exact provider-usage observation instead of inferring it from protocol", () => {
    expect(listExecutionPlans()
      .filter((plan) => plan.usageObserver !== "none")
      .map((plan) => [plan.id, plan.usageObserver])).toEqual([
      ["codex.responses", "responses"],
      ["codex.responses_compact", "responses"],
      ["grok.production.responses", "responses"],
      ["grok.production.images_generations", "image"],
      ["grok.production.images_edits", "image"],
      ["grok.production.videos_generations", "video"],
      ["grok.production.videos_edits", "video"],
      ["grok.production.videos_extensions", "video"],
      ["grok.production.videos_poll", "video"],
      ["xai.production.responses", "responses"],
      ["xai.production.images_generations", "image"],
      ["xai.production.images_edits", "image"],
      ["xai.production.videos_generations", "video"],
      ["xai.production.videos_edits", "video"],
      ["xai.production.videos_extensions", "video"],
      ["xai.production.video", "video"]
    ]);
  });

  it("declares missing SSE Content-Type completion only on transparent Grok and xAI Responses", () => {
    expect(listExecutionPlans()
      .filter((plan) => plan.responseHeaderPolicy !== undefined)
      .map((plan) => [plan.id, plan.responseHeaderPolicy])).toEqual([
      ["grok.production.responses", "complete_missing_sse_content_type"],
      ["xai.production.responses", "complete_missing_sse_content_type"]
    ]);
  });

  it("projects Dashboard labels and provisional billing from exact plan semantics", () => {
    expect(executionPlanPresentation("codex.responses")).toEqual({
      clientLabel: "Codex",
      usageLabel: "Codex",
      usageObserver: "responses",
      provisionalBilling: false
    });
    expect(executionPlanPresentation("grok.production.responses")).toEqual({
      clientLabel: "Grok",
      usageLabel: "Grok 响应",
      usageObserver: "responses",
      provisionalBilling: true
    });
    expect(executionPlanPresentation("grok.production.images_generations").usageLabel).toBe("Grok 图像");
    expect(executionPlanPresentation("xai.production.video").usageLabel).toBe("xAI 视频");
    expect(executionPlanPresentation("codex.historical.responses")).toEqual({
      clientLabel: "Codex",
      usageLabel: "Codex",
      usageObserver: "responses",
      provisionalBilling: false
    });
    expect(executionPlanPresentation("N/A").usageLabel).toBe("历史记录 · 来源未记录");
    expect(executionPlanPresentation("xai.unknown")).toEqual({
      clientLabel: "Client",
      usageLabel: "xai.unknown",
      usageObserver: "none",
      provisionalBilling: false
    });
  });

  it("keeps Codex, Grok, and explicitly granted xAI production hostnames only", () => {
    expect(listHostnames().sort()).toEqual([
      "api.trustedtunnel.app",
      "grok.trustedtunnel.app",
      "xai.trustedtunnel.app"
    ].sort());
    expect(plansForHostname("api-staging.trustedtunnel.app")).toBeNull();
    expect(plansForHostname("grok-staging.trustedtunnel.app")).toBeNull();
    expect(ISSUABLE_SURFACE_GRANTS.has("surface:codex:staging")).toBe(false);
    expect([...ISSUABLE_SURFACE_GRANTS].sort()).toEqual([
      "surface:codex:production",
      "surface:grok:production",
      "surface:xai:production"
    ].sort());
  });

  it("maps every issuable surface grant to at least one plan", () => {
    const planGrants = new Set(listExecutionPlans().map((p) => p.surfaceGrant as string));
    for (const grant of ISSUABLE_SURFACE_GRANTS) {
      expect(planGrants.has(grant)).toBe(true);
    }
  });

  it("gives every Grok and xAI executable plan a canonical audit path", () => {
    const executablePlans = listExecutionPlans().filter((plan) =>
      plan.protocol !== "openai/codex"
    );

    for (const plan of executablePlans) {
      expect(plan.auditPath, plan.id).toBe(publicExecutionPlanPath(plan));
    }
  });

  it("keeps product verification bound to active task-producing plans", () => {
    expect(REAL_TASK_EXECUTION_PLAN_IDS).toEqual([
      "codex.responses",
      "codex.audio_speech",
      "codex.audio_transcriptions",
      "codex.realtime_calls",
      "codex.live",
      "grok.production.chat_completions",
      "grok.production.tts",
      "grok.production.stt",
      "grok.production.responses",
      "grok.production.images_generations",
      "grok.production.images_edits",
      "grok.production.videos_generations",
      "grok.production.videos_edits",
      "grok.production.videos_extensions",
      "xai.production.tokenize_text",
      "xai.production.chat_completions",
      "xai.production.tts",
      "xai.production.stt",
      "xai.production.responses",
      "xai.production.images_generations",
      "xai.production.images_edits",
      "xai.production.videos_generations",
      "xai.production.videos_edits",
      "xai.production.videos_extensions",
      "xai.production.files_upload"
    ]);
    const plans = new Map(listExecutionPlans().map((plan) => [plan.id, plan]));
    expect(listExecutionPlans().filter((plan) => plan.realTask).map((plan) => plan.id))
      .toEqual(REAL_TASK_EXECUTION_PLAN_IDS);
    for (const id of REAL_TASK_EXECUTION_PLAN_IDS) {
      expect(plans.get(id)).toMatchObject({
        method: "POST",
        supportStatus: "active"
      });
      expect(id).not.toContain("compact");
    }
  });

  it("uses documented protocol labels only", () => {
    const allowed = new Set(["openai/codex", "xai/grok", "xai/api"]);
    for (const plan of listExecutionPlans()) {
      expect(allowed.has(plan.protocol)).toBe(true);
      expect(plan.supportStatus === "active" || plan.supportStatus === "deprecated").toBe(true);
      expect(plan.environment).toBe("production");
    }
  });

  it("resolves Grok without reading a transparent body", () => {
    const opaqueBody = new ReadableStream({
      pull() {
        throw new Error("plan lookup must not read the request body");
      }
    });
    const grok = matchExecutionPlan(new Request(
      "https://grok.trustedtunnel.app/v1/responses",
      {
        method: "POST",
        body: opaqueBody,
        duplex: "half"
      } as RequestInit
    ), plansForHostname("grok.trustedtunnel.app") ?? []);
    expect(grok).toMatchObject({
      id: "grok.production.responses",
      credentialSlot: "grok_production",
      surfaceGrant: "surface:grok:production",
      mode: "transparent"
    });
  });

  it("routes Grok image generation to the xAI API with the existing Grok grant", () => {
    const image = matchExecutionPlan(new Request(
      "https://grok.trustedtunnel.app/v1/images/generations",
      {
        method: "POST",
        body: new Uint8Array([0, 255, 1, 2])
      }
    ), plansForHostname("grok.trustedtunnel.app") ?? []);
    expect(image).toMatchObject({
      id: "grok.production.images_generations",
      credentialSlot: "grok_production",
      surfaceGrant: "surface:grok:production",
      mode: "transparent",
      providerBaseUrl: "https://api.x.ai",
      auditPath: "/v1/images/generations"
    });
  });

  it.each([
    ["/v1/language-models", "grok.production.language_models"],
    ["/v1/image-generation-models", "grok.production.image_generation_models"],
    ["/v1/video-generation-models", "grok.production.video_generation_models"],
    ["/v1/tts/voices", "grok.production.tts_voices"]
  ] as const)("routes the direct-authority-proven xAI catalog %s transparently", (pathname, id) => {
    const plan = matchExecutionPlan(new Request(
      `https://grok.trustedtunnel.app${pathname}?limit=1`
    ), plansForHostname("grok.trustedtunnel.app") ?? []);

    expect(plan).toMatchObject({
      id,
      credentialSlot: "grok_production",
      surfaceGrant: "surface:grok:production",
      method: "GET",
      mode: "transparent",
      providerBaseUrl: "https://api.x.ai",
      auditPath: pathname
    });
  });

  it.each([
    ["/v1/language-models/grok-4.5", "grok.production.language_model"],
    ["/v1/image-generation-models/grok-imagine-image", "grok.production.image_generation_model"],
    ["/v1/video-generation-models/grok-imagine-video-1.5", "grok.production.video_generation_model"],
    ["/v1/tts/voices/eve", "grok.production.tts_voice"]
  ] as const)("routes the direct-authority-proven xAI detail %s transparently", (pathname, id) => {
    const plans = plansForHostname("grok.trustedtunnel.app") ?? [];
    expect(matchExecutionPlan(new Request(
      `https://grok.trustedtunnel.app${pathname}`
    ), plans)).toMatchObject({
      id,
      credentialSlot: "grok_production",
      surfaceGrant: "surface:grok:production",
      method: "GET",
      mode: "transparent",
      providerBaseUrl: "https://api.x.ai"
    });
  });

  it("rejects nested or oversized xAI catalog identifiers", () => {
    const plans = plansForHostname("grok.trustedtunnel.app") ?? [];
    expect(matchExecutionPlan(new Request(
      "https://grok.trustedtunnel.app/v1/models/grok-4.5"
    ), plans)).toBeNull();
    expect(matchExecutionPlan(new Request(
      "https://grok.trustedtunnel.app/v1/language-models/model/extra"
    ), plans)).toBeNull();
    expect(matchExecutionPlan(new Request(
      "https://grok.trustedtunnel.app/v1/language-models/model%2Fextra"
    ), plans)).toBeNull();
    expect(matchExecutionPlan(new Request(
      `https://grok.trustedtunnel.app/v1/tts/voices/${"a".repeat(201)}`
    ), plans)).toBeNull();
  });

  it("routes xAI tokenization as an opaque transparent POST", () => {
    const plan = matchExecutionPlan(new Request(
      "https://grok.trustedtunnel.app/v1/tokenize-text",
      { method: "POST", body: new Uint8Array([0, 255, 1]) }
    ), plansForHostname("grok.trustedtunnel.app") ?? []);
    expect(plan).toMatchObject({
      id: "grok.production.tokenize_text",
      credentialSlot: "grok_production",
      surfaceGrant: "surface:grok:production",
      method: "POST",
      mode: "transparent",
      providerBaseUrl: "https://api.x.ai",
      auditPath: "/v1/tokenize-text"
    });
  });

  it.each([
    ["/v1/chat/completions", "grok.production.chat_completions"],
    ["/v1/tts", "grok.production.tts"],
    ["/v1/stt", "grok.production.stt"]
  ] as const)("routes the direct-authority-proven xAI task %s transparently", (pathname, id) => {
    const plan = matchExecutionPlan(new Request(
      `https://grok.trustedtunnel.app${pathname}`,
      { method: "POST", body: new Uint8Array([0, 255, 1]) }
    ), plansForHostname("grok.trustedtunnel.app") ?? []);

    expect(plan).toMatchObject({
      id,
      credentialSlot: "grok_production",
      surfaceGrant: "surface:grok:production",
      method: "POST",
      mode: "transparent",
      providerBaseUrl: "https://api.x.ai",
      auditPath: pathname
    });
  });

  it("keeps xAI task endpoints exact", () => {
    const plans = plansForHostname("grok.trustedtunnel.app") ?? [];
    for (const pathname of [
      "/v1/chat/completions/extra",
      "/v1/tts/extra",
      "/v1/stt/extra"
    ]) {
      expect(matchExecutionPlan(new Request(
        `https://grok.trustedtunnel.app${pathname}`,
        { method: "POST" }
      ), plans)).toBeNull();
    }
  });

  it("routes Grok image editing to the xAI API with the existing Grok grant", () => {
    const image = matchExecutionPlan(new Request(
      "https://grok.trustedtunnel.app/v1/images/edits",
      {
        method: "POST",
        body: new Uint8Array([0, 255, 1, 2])
      }
    ), plansForHostname("grok.trustedtunnel.app") ?? []);
    expect(image).toMatchObject({
      id: "grok.production.images_edits",
      credentialSlot: "grok_production",
      surfaceGrant: "surface:grok:production",
      mode: "transparent",
      providerBaseUrl: "https://api.x.ai",
      auditPath: "/v1/images/edits"
    });
  });

  it("routes Grok and direct REST video start through the existing Grok grant", () => {
    const start = matchExecutionPlan(new Request(
      "https://grok.trustedtunnel.app/v1/videos/generations",
      {
        method: "POST",
        body: new Uint8Array([0, 255, 1, 2])
      }
    ), plansForHostname("grok.trustedtunnel.app") ?? []);
    expect(start).toMatchObject({
      id: "grok.production.videos_generations",
      credentialSlot: "grok_production",
      surfaceGrant: "surface:grok:production",
      mode: "video_start",
      mediaCapability: "video_generation",
      providerBaseUrl: "https://api.x.ai",
      auditPath: "/v1/videos/generations"
    });
  });

  it.each([
    ["/v1/videos/edits", "grok.production.videos_edits", "video_edit"],
    ["/v1/videos/extensions", "grok.production.videos_extensions", "video_extension"]
  ] as const)("routes %s through owner-bound video start", (pathname, id, mediaCapability) => {
    const start = matchExecutionPlan(new Request(
      `https://grok.trustedtunnel.app${pathname}`,
      {
        method: "POST",
        body: new Uint8Array([0, 255, 1, 2])
      }
    ), plansForHostname("grok.trustedtunnel.app") ?? []);
    expect(start).toMatchObject({
      id,
      credentialSlot: "grok_production",
      surfaceGrant: "surface:grok:production",
      mode: "video_start",
      mediaCapability,
      providerBaseUrl: "https://api.x.ai",
      auditPath: pathname
    });
  });

  it("matches only a constrained Grok video polling identifier", () => {
    const plans = plansForHostname("grok.trustedtunnel.app") ?? [];
    const poll = matchExecutionPlan(new Request(
      "https://grok.trustedtunnel.app/v1/videos/d97415a1-5796-b7ec-379f-4e6819e08fdf"
    ), plans);
    expect(poll).toMatchObject({
      id: "grok.production.videos_poll",
      method: "GET",
      mode: "video_poll",
      providerBaseUrl: "https://api.x.ai",
      auditPath: "/v1/videos/{request_id}"
    });
    expect(matchExecutionPlan(new Request(
      "https://grok.trustedtunnel.app/v1/videos/not%2Fa%2Fsingle%2Fsegment"
    ), plans)).toBeNull();
    expect(matchExecutionPlan(new Request(
      `https://grok.trustedtunnel.app/v1/videos/${"a".repeat(201)}`
    ), plans)).toBeNull();
    expect(matchExecutionPlan(new Request(
      "https://grok.trustedtunnel.app/v1/videos/job-id/extra"
    ), plans)).toBeNull();
  });

  it("exposes only exact owner-bound Files API operations", () => {
    const plans = plansForHostname("grok.trustedtunnel.app") ?? [];
    const fileId = "file_7de029f4-eb66-42ee-87f8-b2a9d9e7466a";
    expect(matchExecutionPlan(new Request(
      "https://grok.trustedtunnel.app/v1/files",
      { method: "POST", body: new Uint8Array([1, 2, 3]) }
    ), plans)).toMatchObject({
      id: "grok.production.files_upload",
      mode: "file_upload",
      auditPath: "/v1/files"
    });
    expect(matchExecutionPlan(new Request(
      `https://grok.trustedtunnel.app/v1/files/${fileId}`
    ), plans)).toMatchObject({
      id: "grok.production.files_metadata",
      mode: "file_owner",
      auditPath: "/v1/files/{file_id}"
    });
    expect(matchExecutionPlan(new Request(
      `https://grok.trustedtunnel.app/v1/files/${fileId}/content`
    ), plans)).toMatchObject({
      id: "grok.production.files_content",
      mode: "file_owner",
      auditPath: "/v1/files/{file_id}/content"
    });
    expect(matchExecutionPlan(new Request(
      `https://grok.trustedtunnel.app/v1/files/${fileId}`,
      { method: "DELETE" }
    ), plans)).toMatchObject({
      id: "grok.production.files_delete",
      mode: "file_owner",
      auditPath: "/v1/files/{file_id}"
    });
    expect(matchExecutionPlan(new Request(
      "https://grok.trustedtunnel.app/v1/files"
    ), plans)).toBeNull();
    expect(matchExecutionPlan(new Request(
      "https://grok.trustedtunnel.app/v1/files/not-a-provider-id"
    ), plans)).toBeNull();
  });

  it("matches Codex speech, transcription, and Codex Realtime OpenAI paths", () => {
    const plans = plansForHostname("api.trustedtunnel.app") ?? [];
    expect(matchExecutionPlan(new Request("https://api.trustedtunnel.app/v1/audio/speech", {
      method: "POST"
    }), plans)).toMatchObject({
      id: "codex.audio_speech",
      providerBaseUrl: "https://api.openai.com",
      upstreamClientIdentity: "none"
    });
    expect(matchExecutionPlan(new Request("https://api.trustedtunnel.app/v1/audio/transcriptions", {
      method: "POST"
    }), plans)).toMatchObject({
      id: "codex.audio_transcriptions",
      providerBaseUrl: "https://api.openai.com"
    });
    expect(matchExecutionPlan(new Request("https://api.trustedtunnel.app/v1/realtime?intent=quicksilver&model=gpt-realtime-1.5", {
      headers: { Upgrade: "websocket" }
    }), plans)).toMatchObject({
      id: "codex.realtime_websocket",
      providerBaseUrl: "https://api.openai.com",
      mode: "websocket_transparent"
    });
    expect(matchExecutionPlan(new Request("https://api.trustedtunnel.app/v1/realtime/calls?intent=quicksilver&architecture=avas", {
      method: "POST"
    }), plans)).toMatchObject({
      id: "codex.realtime_calls",
      providerBaseUrl: "https://api.openai.com",
      upstreamClientIdentity: "none"
    });
    expect(matchExecutionPlan(new Request("https://api.trustedtunnel.app/v1/live", {
      method: "POST"
    }), plans)).toMatchObject({
      id: "codex.live",
      providerBaseUrl: "https://api.openai.com"
    });
    expect(matchExecutionPlan(new Request("https://api.trustedtunnel.app/v1/live?model=gpt-live-1-codex", {
      headers: { Upgrade: "websocket" }
    }), plans)).toMatchObject({
      id: "codex.live_websocket",
      mode: "websocket_transparent"
    });
    expect(matchExecutionPlan(new Request("https://api.trustedtunnel.app/v1/live/rtc_test", {
      headers: { Upgrade: "websocket" }
    }), plans)).toMatchObject({
      id: "codex.live_call_websocket",
      auditPath: "/v1/live/{call_id}"
    });
    expect(matchExecutionPlan(new Request("https://api.trustedtunnel.app/v1/realtime"), plans)).toBeNull();
    expect(matchExecutionPlan(new Request("https://api.trustedtunnel.app/v1/realtime/calls", {
      headers: { Upgrade: "websocket" }
    }), plans)).toBeNull();
    expect(matchExecutionPlan(new Request("https://api.trustedtunnel.app/v1/live"), plans)).toBeNull();
  });

  it("marks the Codex WebSocket 426 compatibility surface deprecated", () => {
    const plan = listExecutionPlans().find(
      (candidate) => candidate.id === "codex.responses_websocket"
    );
    expect(plan).toMatchObject({
      mode: "websocket_426",
      supportStatus: "deprecated"
    });
  });
});
