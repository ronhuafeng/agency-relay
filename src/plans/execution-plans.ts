/**
 * One immutable Execution Plan per accepted ingress.
 * Exact lookup only — no registry, shadow selector, or candidate list.
 * Product surfaces: Codex (ChatGPT), Grok, and admin-authorized xAI API.
 * Staging hostnames/grants/slots are not product surfaces; environment remains a
 * data-model field for subscription metadata only.
 * Route selection is hostname+method+path only. Shared host, grant, protocol
 * and credential slot have one Provider profile declaration.
 */
export const EXECUTION_PLAN_SET_VERSION = "adr-0017.v1";
export const CODEX_API_HOSTNAME = "api.trustedtunnel.app";
export const XAI_API_HOSTNAME = "xai.trustedtunnel.app";
const GROK_CLI_PROVIDER_BASE_URL = "https://cli-chat-proxy.grok.com";
const XAI_API_PROVIDER_BASE_URL = "https://api.x.ai";
const OPENAI_API_PROVIDER_BASE_URL = "https://api.openai.com";

type PlanEnvironment = "production";
export type CredentialSlotId = "chatgpt_production" | "grok_production";

/**
 * Execution modes (M7: do not add convert/normalize/chat_completions modes).
 * - transparent: opaque single-pass request/response (no body parse)
 * - video_start/video_poll: owner-bound xAI asynchronous control responses
 * - file_upload/file_owner: owner-bound xAI Files operations
 * - websocket_transparent: opaque bidirectional WebSocket relay
 * - websocket_426: deprecated Codex WS compatibility rejection
 */
export type ExecutionMode =
  | "transparent"
  | "file_upload"
  | "file_owner"
  | "video_start"
  | "video_poll"
  | "websocket_transparent"
  | "websocket_426";

/** Provider wire dialect labels only. */
export type IngressProtocol = "openai/codex" | "xai/grok" | "xai/api";

/** active | deprecated only. */
export type PlanSupportStatus = "active" | "deprecated";
export type VideoCapability = "video_generation" | "video_edit" | "video_extension";
export type UsageObserver = "responses" | "image" | "video" | "none";
export type CreditCharge = 0 | 1;
export type ResponseHeaderPolicy = "complete_missing_sse_content_type";
export type UpstreamClientIdentity = "codex_cli" | "grok_build" | "none";

export interface ExecutionPlan {
  /** Stable plan id projected to audit/readiness/docs. */
  id: string;
  hostname: string;
  environment: PlanEnvironment;
  /** Exact surface grant required, e.g. surface:grok:production */
  surfaceGrant: `surface:${string}:${PlanEnvironment}`;
  method: "GET" | "POST" | "DELETE";
  pathname: string | RegExp;
  upgrade?: "websocket";
  protocol: IngressProtocol;
  credentialSlot: CredentialSlotId;
  mode: ExecutionMode;
  /** Official Provider client identity used for native pass-through or fallback projection. */
  upstreamClientIdentity: UpstreamClientIdentity;
  /** Exact provider metadata observer; none preserves a fully opaque body. */
  usageObserver: UsageObserver;
  /** Exact response-header projection; absent means preserve Provider headers. */
  responseHeaderPolicy?: ResponseHeaderPolicy;
  /** Mini-owned fixed Credit charged before this plan's Provider attempt. */
  creditCharge: CreditCharge;
  /** True when a successful attempt proves that the client completed real work. */
  realTask: boolean;
  /** Usage capability bound when a video start returns a provider request_id. */
  mediaCapability?: VideoCapability;
  /** Fixed provider origin for plans that perform Grok egress. */
  providerBaseUrl?: string;
  /** Canonical route label for audit and presentation; required for RegExp pathname. */
  auditPath?: string;
  supportStatus: PlanSupportStatus;
  notes: string;
}

export function publicExecutionPlanPath(plan: ExecutionPlan): string {
  const path = plan.auditPath ?? (typeof plan.pathname === "string" ? plan.pathname : null);
  if (!path) {
    throw new Error(`Execution Plan ${plan.id} has no canonical public path`);
  }
  return path;
}

/** Provider relay is the only current domain. The value does not select a credential or an authentication mechanism. */
export type RelayDomain = "provider";

/** One writable declaration of the facts shared by every operation on a surface. */
export interface ProviderRelayProfile {
  readonly id: "codex" | "grok" | "xai";
  readonly domain: RelayDomain;
  readonly hostname: string;
  readonly environment: PlanEnvironment;
  readonly surfaceGrant: `surface:${string}:${PlanEnvironment}`;
  readonly protocol: IngressProtocol;
  readonly credentialSlot: CredentialSlotId;
  readonly clientLabel: "Codex" | "Grok" | "xAI API";
}

export const PROVIDER_RELAY_PROFILES = {
  codex: {
    id: "codex",
    domain: "provider",
    hostname: CODEX_API_HOSTNAME,
    environment: "production",
    surfaceGrant: "surface:codex:production",
    protocol: "openai/codex",
    credentialSlot: "chatgpt_production",
    clientLabel: "Codex"
  },
  grok: {
    id: "grok",
    domain: "provider",
    hostname: "grok.trustedtunnel.app",
    environment: "production",
    surfaceGrant: "surface:grok:production",
    protocol: "xai/grok",
    credentialSlot: "grok_production",
    clientLabel: "Grok"
  },
  xai: {
    id: "xai",
    domain: "provider",
    hostname: XAI_API_HOSTNAME,
    environment: "production",
    surfaceGrant: "surface:xai:production",
    protocol: "xai/api",
    credentialSlot: "grok_production",
    clientLabel: "xAI API"
  }
} as const satisfies Record<ProviderRelayProfile["id"], ProviderRelayProfile>;

type PlanOperation = Omit<ExecutionPlan, "hostname" | "environment" | "surfaceGrant" | "protocol" | "credentialSlot">;

function bindProfile(profile: ProviderRelayProfile, operation: PlanOperation): ExecutionPlan {
  return {
    ...operation,
    hostname: profile.hostname,
    environment: profile.environment,
    surfaceGrant: profile.surfaceGrant,
    protocol: profile.protocol,
    credentialSlot: profile.credentialSlot
  };
}

const PROFILE_BY_GRANT = new Map<string, ProviderRelayProfile>(
  Object.values(PROVIDER_RELAY_PROFILES).map(profile => [profile.surfaceGrant, profile])
);

/** Read projection of the one profile declaration. Unknown grants stay unknown. */
export function profileForSurfaceGrant(grant: string): ProviderRelayProfile | undefined {
  return PROFILE_BY_GRANT.get(grant);
}

function codexProductionPlans(): ExecutionPlan[] {
  const plans: PlanOperation[] = [
    {
      id: "codex.models",
      method: "GET",
      pathname: "/v1/models",
      mode: "transparent",
      upstreamClientIdentity: "codex_cli",
      usageObserver: "none",
      creditCharge: 0,
      realTask: false,
      supportStatus: "active",
      notes: "Codex models — transparent egress"
    },
    {
      id: "codex.responses",
      method: "POST",
      pathname: "/v1/responses",
      mode: "transparent",
      upstreamClientIdentity: "codex_cli",
      usageObserver: "responses",
      creditCharge: 1,
      realTask: true,
      auditPath: "/v1/responses",
      supportStatus: "active",
      notes: "Codex Responses — single-pass transparent"
    },
    {
      id: "codex.responses_compact",
      method: "POST",
      pathname: "/v1/responses/compact",
      mode: "transparent",
      upstreamClientIdentity: "codex_cli",
      usageObserver: "responses",
      creditCharge: 1,
      realTask: false,
      auditPath: "/v1/responses/compact",
      supportStatus: "active",
      notes: "Codex compact — unary transparent"
    },
    {
      id: "codex.responses_websocket",
      method: "GET",
      pathname: "/v1/responses",
      upgrade: "websocket",
      mode: "websocket_426",
      upstreamClientIdentity: "none",
      usageObserver: "none",
      creditCharge: 0,
      realTask: false,
      supportStatus: "deprecated",
      notes: "Deprecated compatibility rejection — WebSocket upgrade receives typed 426"
    },
    {
      id: "codex.audio_speech",
      method: "POST",
      pathname: "/v1/audio/speech",
      mode: "transparent",
      upstreamClientIdentity: "none",
      usageObserver: "none",
      creditCharge: 1,
      realTask: true,
      providerBaseUrl: OPENAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/audio/speech",
      supportStatus: "active",
      notes: "Codex speech — transparent OpenAI API"
    },
    {
      id: "codex.audio_transcriptions",
      method: "POST",
      pathname: "/v1/audio/transcriptions",
      mode: "transparent",
      upstreamClientIdentity: "none",
      usageObserver: "none",
      creditCharge: 1,
      realTask: true,
      providerBaseUrl: OPENAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/audio/transcriptions",
      supportStatus: "active",
      notes: "Codex transcriptions — transparent OpenAI API"
    },
    {
      id: "codex.realtime_websocket",
      method: "GET",
      pathname: "/v1/realtime",
      upgrade: "websocket",
      mode: "websocket_transparent",
      upstreamClientIdentity: "none",
      usageObserver: "none",
      creditCharge: 1,
      realTask: false,
      providerBaseUrl: OPENAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/realtime",
      supportStatus: "active",
      notes: "Codex Realtime WebSocket — opaque OpenAI API"
    },
    {
      id: "codex.realtime_calls",
      method: "POST",
      pathname: "/v1/realtime/calls",
      mode: "transparent",
      upstreamClientIdentity: "none",
      usageObserver: "none",
      creditCharge: 1,
      realTask: true,
      providerBaseUrl: OPENAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/realtime/calls",
      supportStatus: "active",
      notes: "Codex Realtime WebRTC call create — transparent OpenAI API"
    },
    {
      id: "codex.live",
      method: "POST",
      pathname: "/v1/live",
      mode: "transparent",
      upstreamClientIdentity: "none",
      usageObserver: "none",
      creditCharge: 1,
      realTask: true,
      providerBaseUrl: OPENAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/live",
      supportStatus: "active",
      notes: "Codex Realtime v3 call create — transparent OpenAI API"
    },
    {
      id: "codex.live_websocket",
      method: "GET",
      pathname: "/v1/live",
      upgrade: "websocket",
      mode: "websocket_transparent",
      upstreamClientIdentity: "none",
      usageObserver: "none",
      creditCharge: 1,
      realTask: false,
      providerBaseUrl: OPENAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/live",
      supportStatus: "active",
      notes: "Codex Realtime v3 WebSocket — opaque OpenAI API"
    },
    {
      id: "codex.live_call_websocket",
      method: "GET",
      pathname: /^\/v1\/live\/(?![^/]*%2[fF])[^/]{1,200}$/,
      upgrade: "websocket",
      mode: "websocket_transparent",
      upstreamClientIdentity: "none",
      usageObserver: "none",
      creditCharge: 1,
      realTask: false,
      providerBaseUrl: OPENAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/live/{call_id}",
      supportStatus: "active",
      notes: "Codex Realtime v3 sideband — opaque OpenAI API"
    }
  ];
  return plans.map(operation => bindProfile(PROVIDER_RELAY_PROFILES.codex, operation));
}

function grokProductionPlans(): ExecutionPlan[] {
  const providerPathSegment = "(?![^/]*%2[fF])[^/]{1,200}";
  const fileId = "file_[A-Za-z0-9_-]{1,200}";
  const plans: PlanOperation[] = [
    {
      id: "grok.production.models",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/models",
      mode: "transparent",
      upstreamClientIdentity: "grok_build",
      providerBaseUrl: GROK_CLI_PROVIDER_BASE_URL,
      auditPath: "/v1/models",
      supportStatus: "active",
      notes: "Transparent Grok CLI gateway catalog"
    },
    {
      id: "grok.production.language_models",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/language-models",
      mode: "transparent",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/language-models",
      supportStatus: "active",
      notes: "Transparent xAI language-model catalog"
    },
    {
      id: "grok.production.image_generation_models",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/image-generation-models",
      mode: "transparent",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/image-generation-models",
      supportStatus: "active",
      notes: "Transparent xAI image-model catalog"
    },
    {
      id: "grok.production.video_generation_models",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/video-generation-models",
      mode: "transparent",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/video-generation-models",
      supportStatus: "active",
      notes: "Transparent xAI video-model catalog"
    },
    {
      id: "grok.production.tts_voices",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/tts/voices",
      mode: "transparent",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/tts/voices",
      supportStatus: "active",
      notes: "Transparent xAI TTS voice catalog"
    },
    {
      id: "grok.production.language_model",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/language-models/${providerPathSegment}$`),
      mode: "transparent",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/language-models/{model_id}",
      supportStatus: "active",
      notes: "Transparent xAI language-model detail"
    },
    {
      id: "grok.production.image_generation_model",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/image-generation-models/${providerPathSegment}$`),
      mode: "transparent",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/image-generation-models/{model_id}",
      supportStatus: "active",
      notes: "Transparent xAI image-model detail"
    },
    {
      id: "grok.production.video_generation_model",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/video-generation-models/${providerPathSegment}$`),
      mode: "transparent",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/video-generation-models/{model_id}",
      supportStatus: "active",
      notes: "Transparent xAI video-model detail"
    },
    {
      id: "grok.production.tts_voice",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/tts/voices/${providerPathSegment}$`),
      mode: "transparent",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/tts/voices/{voice_id}",
      supportStatus: "active",
      notes: "Transparent xAI TTS voice detail"
    },
    {
      id: "grok.production.tokenize_text",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "POST",
      pathname: "/v1/tokenize-text",
      mode: "transparent",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/tokenize-text",
      supportStatus: "active",
      notes: "Opaque xAI text tokenization"
    },
    {
      id: "grok.production.chat_completions",
      creditCharge: 1,
      usageObserver: "none",
      realTask: true,
      method: "POST",
      pathname: "/v1/chat/completions",
      mode: "transparent",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/chat/completions",
      supportStatus: "active",
      notes: "Single-pass transparent xAI Chat Completions"
    },
    {
      id: "grok.production.tts",
      creditCharge: 1,
      usageObserver: "none",
      realTask: true,
      method: "POST",
      pathname: "/v1/tts",
      mode: "transparent",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/tts",
      supportStatus: "active",
      notes: "Single-pass transparent xAI text to speech"
    },
    {
      id: "grok.production.stt",
      creditCharge: 1,
      usageObserver: "none",
      realTask: true,
      method: "POST",
      pathname: "/v1/stt",
      mode: "transparent",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/stt",
      supportStatus: "active",
      notes: "Single-pass transparent xAI speech to text"
    },
    {
      id: "grok.production.responses",
      creditCharge: 1,
      realTask: true,
      method: "POST",
      pathname: "/v1/responses",
      mode: "transparent",
      upstreamClientIdentity: "grok_build",
      usageObserver: "responses",
      responseHeaderPolicy: "complete_missing_sse_content_type",
      providerBaseUrl: GROK_CLI_PROVIDER_BASE_URL,
      auditPath: "/v1/responses",
      supportStatus: "active",
      notes: "Single-pass transparent Grok CLI gateway"
    },
    {
      id: "grok.production.images_generations",
      creditCharge: 1,
      realTask: true,
      method: "POST",
      pathname: "/v1/images/generations",
      mode: "transparent",
      upstreamClientIdentity: "none",
      usageObserver: "image",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/images/generations",
      supportStatus: "active",
      notes: "Single-pass transparent xAI image generation"
    },
    {
      id: "grok.production.images_edits",
      creditCharge: 1,
      realTask: true,
      method: "POST",
      pathname: "/v1/images/edits",
      mode: "transparent",
      upstreamClientIdentity: "none",
      usageObserver: "image",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/images/edits",
      supportStatus: "active",
      notes: "Single-pass transparent xAI image editing"
    },
    {
      id: "grok.production.videos_generations",
      creditCharge: 1,
      realTask: true,
      method: "POST",
      pathname: "/v1/videos/generations",
      mode: "video_start",
      upstreamClientIdentity: "none",
      usageObserver: "video",
      mediaCapability: "video_generation",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/videos/generations",
      supportStatus: "active",
      notes: "Opaque xAI video start with owner-bound control response"
    },
    {
      id: "grok.production.videos_edits",
      creditCharge: 1,
      realTask: true,
      method: "POST",
      pathname: "/v1/videos/edits",
      mode: "video_start",
      upstreamClientIdentity: "none",
      usageObserver: "video",
      mediaCapability: "video_edit",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/videos/edits",
      supportStatus: "active",
      notes: "Opaque xAI video edit start with owner-bound control response"
    },
    {
      id: "grok.production.videos_extensions",
      creditCharge: 1,
      realTask: true,
      method: "POST",
      pathname: "/v1/videos/extensions",
      mode: "video_start",
      upstreamClientIdentity: "none",
      usageObserver: "video",
      mediaCapability: "video_extension",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/videos/extensions",
      supportStatus: "active",
      notes: "Opaque xAI video extension start with owner-bound control response"
    },
    {
      id: "grok.production.videos_poll",
      creditCharge: 1,
      realTask: false,
      method: "GET",
      pathname: /^\/v1\/videos\/[A-Za-z0-9_-]{1,200}$/,
      mode: "video_poll",
      upstreamClientIdentity: "none",
      usageObserver: "video",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/videos/{request_id}",
      supportStatus: "active",
      notes: "Owner-bound xAI video status polling"
    },
    {
      id: "grok.production.files_upload",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "POST",
      pathname: "/v1/files",
      mode: "file_upload",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/files",
      supportStatus: "active",
      notes: "Opaque xAI file upload with owner-bound metadata response"
    },
    {
      id: "grok.production.files_metadata",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/files/${fileId}$`),
      mode: "file_owner",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/files/{file_id}",
      supportStatus: "active",
      notes: "Owner-bound xAI file metadata"
    },
    {
      id: "grok.production.files_content",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/files/${fileId}/content$`),
      mode: "file_owner",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/files/{file_id}/content",
      supportStatus: "active",
      notes: "Owner-bound streaming xAI file content"
    },
    {
      id: "grok.production.files_delete",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "DELETE",
      pathname: new RegExp(`^/v1/files/${fileId}$`),
      mode: "file_owner",
      upstreamClientIdentity: "none",
      providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
      auditPath: "/v1/files/{file_id}",
      supportStatus: "active",
      notes: "Owner-bound xAI file deletion"
    }
  ];
  return plans.map(operation => bindProfile(PROVIDER_RELAY_PROFILES.grok, operation));
}

function xaiProductionPlans(): ExecutionPlan[] {
  const providerPathSegment = "(?![^/]*%2[fF])[^/]{1,200}";
  type XaiRoute = Pick<ExecutionPlan,
    | "id"
    | "method"
    | "pathname"
    | "auditPath"
    | "upgrade"
    | "mediaCapability"
    | "creditCharge"
    | "usageObserver"
    | "responseHeaderPolicy"
    | "realTask"
  > & {
    mode?: ExecutionMode;
  };
  const routes: ReadonlyArray<XaiRoute> = [
    {
      id: "xai.production.models",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/models",
      auditPath: "/v1/models"
    },
    {
      id: "xai.production.model",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/models/${providerPathSegment}$`),
      auditPath: "/v1/models/{model_id}"
    },
    {
      id: "xai.production.language_models",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/language-models",
      auditPath: "/v1/language-models"
    },
    {
      id: "xai.production.image_generation_models",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/image-generation-models",
      auditPath: "/v1/image-generation-models"
    },
    {
      id: "xai.production.video_generation_models",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/video-generation-models",
      auditPath: "/v1/video-generation-models"
    },
    {
      id: "xai.production.tts_voices",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/tts/voices",
      auditPath: "/v1/tts/voices"
    },
    {
      id: "xai.production.language_model",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/language-models/${providerPathSegment}$`),
      auditPath: "/v1/language-models/{model_id}"
    },
    {
      id: "xai.production.image_generation_model",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/image-generation-models/${providerPathSegment}$`),
      auditPath: "/v1/image-generation-models/{model_id}"
    },
    {
      id: "xai.production.video_generation_model",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/video-generation-models/${providerPathSegment}$`),
      auditPath: "/v1/video-generation-models/{model_id}"
    },
    {
      id: "xai.production.tts_voice",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/tts/voices/${providerPathSegment}$`),
      auditPath: "/v1/tts/voices/{voice_id}"
    },
    {
      id: "xai.production.tokenize_text",
      creditCharge: 1,
      usageObserver: "none",
      realTask: true,
      method: "POST",
      pathname: "/v1/tokenize-text",
      auditPath: "/v1/tokenize-text"
    },
    {
      id: "xai.production.chat_completions",
      creditCharge: 1,
      usageObserver: "none",
      realTask: true,
      method: "POST",
      pathname: "/v1/chat/completions",
      auditPath: "/v1/chat/completions"
    },
    {
      id: "xai.production.chat_deferred_completion",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/chat/deferred-completion/${providerPathSegment}$`),
      auditPath: "/v1/chat/deferred-completion/{request_id}"
    },
    {
      id: "xai.production.tts",
      creditCharge: 1,
      usageObserver: "none",
      realTask: true,
      method: "POST",
      pathname: "/v1/tts",
      auditPath: "/v1/tts"
    },
    {
      id: "xai.production.stt",
      creditCharge: 1,
      usageObserver: "none",
      realTask: true,
      method: "POST",
      pathname: "/v1/stt",
      auditPath: "/v1/stt"
    },
    {
      id: "xai.production.responses",
      creditCharge: 1,
      usageObserver: "responses",
      responseHeaderPolicy: "complete_missing_sse_content_type",
      realTask: true,
      method: "POST",
      pathname: "/v1/responses",
      auditPath: "/v1/responses"
    },
    {
      id: "xai.production.responses_compact",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "POST",
      pathname: "/v1/responses/compact",
      auditPath: "/v1/responses/compact"
    },
    {
      id: "xai.production.response",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/responses/${providerPathSegment}$`),
      auditPath: "/v1/responses/{response_id}"
    },
    {
      id: "xai.production.response_delete",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "DELETE",
      pathname: new RegExp(`^/v1/responses/${providerPathSegment}$`),
      auditPath: "/v1/responses/{response_id}"
    },
    {
      id: "xai.production.images_generations",
      creditCharge: 1,
      usageObserver: "image",
      realTask: true,
      method: "POST",
      pathname: "/v1/images/generations",
      auditPath: "/v1/images/generations"
    },
    {
      id: "xai.production.images_edits",
      creditCharge: 1,
      usageObserver: "image",
      realTask: true,
      method: "POST",
      pathname: "/v1/images/edits",
      auditPath: "/v1/images/edits"
    },
    {
      id: "xai.production.videos_generations",
      creditCharge: 1,
      usageObserver: "video",
      realTask: true,
      method: "POST",
      pathname: "/v1/videos/generations",
      auditPath: "/v1/videos/generations",
      mediaCapability: "video_generation"
    },
    {
      id: "xai.production.videos_edits",
      creditCharge: 1,
      usageObserver: "video",
      realTask: true,
      method: "POST",
      pathname: "/v1/videos/edits",
      auditPath: "/v1/videos/edits",
      mediaCapability: "video_edit"
    },
    {
      id: "xai.production.videos_extensions",
      creditCharge: 1,
      usageObserver: "video",
      realTask: true,
      method: "POST",
      pathname: "/v1/videos/extensions",
      auditPath: "/v1/videos/extensions",
      mediaCapability: "video_extension"
    },
    {
      id: "xai.production.video",
      creditCharge: 1,
      usageObserver: "video",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/videos/${providerPathSegment}$`),
      auditPath: "/v1/videos/{request_id}"
    },
    {
      id: "xai.production.files_upload",
      creditCharge: 1,
      usageObserver: "none",
      realTask: true,
      method: "POST",
      pathname: "/v1/files",
      auditPath: "/v1/files"
    },
    {
      id: "xai.production.files_list",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/files",
      auditPath: "/v1/files"
    },
    {
      id: "xai.production.file",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/files/${providerPathSegment}$`),
      auditPath: "/v1/files/{file_id}"
    },
    {
      id: "xai.production.file_content",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/files/${providerPathSegment}/content$`),
      auditPath: "/v1/files/{file_id}/content"
    },
    {
      id: "xai.production.file_delete",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "DELETE",
      pathname: new RegExp(`^/v1/files/${providerPathSegment}$`),
      auditPath: "/v1/files/{file_id}"
    },
    {
      id: "xai.production.custom_voices",
      creditCharge: 0,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/custom-voices",
      auditPath: "/v1/custom-voices"
    },
    {
      id: "xai.production.batches",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/batches",
      auditPath: "/v1/batches"
    },
    {
      id: "xai.production.batches_create",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "POST",
      pathname: "/v1/batches",
      auditPath: "/v1/batches"
    },
    {
      id: "xai.production.batch",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/batches/${providerPathSegment}$`),
      auditPath: "/v1/batches/{batch_id}"
    },
    {
      id: "xai.production.batch_requests",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/batches/${providerPathSegment}/requests$`),
      auditPath: "/v1/batches/{batch_id}/requests"
    },
    {
      id: "xai.production.batch_requests_add",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "POST",
      pathname: new RegExp(`^/v1/batches/${providerPathSegment}/requests$`),
      auditPath: "/v1/batches/{batch_id}/requests"
    },
    {
      id: "xai.production.batch_results",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: new RegExp(`^/v1/batches/${providerPathSegment}/results$`),
      auditPath: "/v1/batches/{batch_id}/results"
    },
    {
      id: "xai.production.batch_cancel",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "POST",
      pathname: new RegExp(`^/v1/batches/${providerPathSegment}:cancel$`),
      auditPath: "/v1/batches/{batch_id}:cancel"
    },
    {
      id: "xai.production.file_public_url",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "POST",
      pathname: new RegExp(`^/v1/files/${providerPathSegment}/public-url$`),
      auditPath: "/v1/files/{file_id}/public-url"
    },
    {
      id: "xai.production.file_public_url_revoke",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "POST",
      pathname: new RegExp(`^/v1/files/${providerPathSegment}/public-url/revoke$`),
      auditPath: "/v1/files/{file_id}/public-url/revoke"
    },
    {
      id: "xai.production.documents_search",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "POST",
      pathname: "/v1/documents/search",
      auditPath: "/v1/documents/search"
    },
    {
      id: "xai.production.realtime_client_secrets",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "POST",
      pathname: "/v1/realtime/client_secrets",
      auditPath: "/v1/realtime/client_secrets"
    },
    {
      id: "xai.production.responses_websocket",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/responses",
      auditPath: "/v1/responses",
      upgrade: "websocket",
      mode: "websocket_transparent"
    },
    {
      id: "xai.production.tts_websocket",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/tts",
      auditPath: "/v1/tts",
      upgrade: "websocket",
      mode: "websocket_transparent"
    },
    {
      id: "xai.production.stt_websocket",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/stt",
      auditPath: "/v1/stt",
      upgrade: "websocket",
      mode: "websocket_transparent"
    },
    {
      id: "xai.production.realtime_websocket",
      creditCharge: 1,
      usageObserver: "none",
      realTask: false,
      method: "GET",
      pathname: "/v1/realtime",
      auditPath: "/v1/realtime",
      upgrade: "websocket",
      mode: "websocket_transparent"
    }
  ];

  return routes.map((route) => bindProfile(PROVIDER_RELAY_PROFILES.xai, {
    ...route,
    mode: route.mode ?? "transparent",
    upstreamClientIdentity: "none",
    providerBaseUrl: XAI_API_PROVIDER_BASE_URL,
    supportStatus: "active",
    notes: `Single-pass transparent xAI API ${route.auditPath}`
  }));
}

/** Single source of route identity — production hostnames only. */
export const EXECUTION_PLANS: readonly ExecutionPlan[] = [
  ...codexProductionPlans(),
  ...grokProductionPlans(),
  ...xaiProductionPlans()
] as const;

const PLAN_BY_ID = new Map(EXECUTION_PLANS.map((plan) => [plan.id, plan]));
if (PLAN_BY_ID.size !== EXECUTION_PLANS.length) {
  throw new Error("Execution Plan ids must be unique");
}

/** Exact task-producing plans that can prove a client did real work. */
export const REAL_TASK_EXECUTION_PLAN_IDS: readonly string[] = EXECUTION_PLANS
  .filter((plan) => plan.realTask)
  .map((plan) => plan.id);

export interface ExecutionPlanPresentation {
  clientLabel: "Codex" | "Grok" | "xAI API" | "Client";
  usageLabel: string;
  usageObserver: UsageObserver;
  costBasis: "provider_reported" | "openai_standard" | "none";
}

/**
 * One exact projection for operator-facing Execution Plan labels and billing.
 * Historical ids are explicit exceptions. Unknown ids are never inferred.
 */
export function executionPlanPresentation(planId: string): ExecutionPlanPresentation {
  if (planId === "codex.historical.responses") {
    return {
      clientLabel: "Codex",
      usageLabel: "Codex",
      usageObserver: "responses",
      costBasis: "openai_standard"
    };
  }
  if (planId === "N/A") {
    return {
      clientLabel: "Client",
      usageLabel: "历史记录 · 来源未记录",
      usageObserver: "none",
      costBasis: "none"
    };
  }

  const plan = PLAN_BY_ID.get(planId);
  if (!plan) {
    return {
      clientLabel: "Client",
      usageLabel: planId,
      usageObserver: "none",
      costBasis: "none"
    };
  }

  const profile = PROFILE_BY_GRANT.get(plan.surfaceGrant);
  if (!profile) {
    return {
      clientLabel: "Client",
      usageLabel: plan.id,
      usageObserver: plan.usageObserver,
      costBasis: "none"
    };
  }
  if (profile.id === "codex") {
    return {
      clientLabel: profile.clientLabel,
      usageLabel: profile.clientLabel,
      usageObserver: plan.usageObserver,
      costBasis: plan.usageObserver === "responses" ? "openai_standard" : "none"
    };
  }
  const clientLabel = profile.clientLabel;
  const usagePrefix = clientLabel === "xAI API" ? "xAI" : clientLabel;
  const usageLabel = plan.usageObserver === "responses"
    ? `${usagePrefix} 响应`
    : plan.usageObserver === "image"
      ? `${usagePrefix} 图像`
      : plan.usageObserver === "video"
        ? `${usagePrefix} 视频`
        : clientLabel;
  return {
    clientLabel,
    usageLabel,
    usageObserver: plan.usageObserver,
    costBasis: plan.credentialSlot === "grok_production" ? "provider_reported" : "none"
  };
}

const BY_HOST = new Map<string, ExecutionPlan[]>();
for (const plan of EXECUTION_PLANS) {
  const list = BY_HOST.get(plan.hostname) ?? [];
  list.push(plan);
  BY_HOST.set(plan.hostname, list);
}

export function listExecutionPlans(): readonly ExecutionPlan[] {
  return EXECUTION_PLANS;
}

export function listHostnames(): string[] {
  return [...BY_HOST.keys()];
}

/** Host has accepted plans (for auth-before-policy). */
export function plansForHostname(hostname: string): ExecutionPlan[] | null {
  const plans = BY_HOST.get(hostname.toLowerCase());
  return plans ? [...plans] : null;
}

/**
 * Exact plan match. Does not read the body.
 * Returns null when host is known but method/path/upgrade is not accepted.
 */
export function matchExecutionPlan(request: Request, plans: readonly ExecutionPlan[]): ExecutionPlan | null {
  const url = new URL(request.url);
  const upgrade = request.headers.get("Upgrade")?.toLowerCase();
  if (upgrade === "websocket") {
    const ws = plans.find((plan) =>
      plan.upgrade === "websocket"
      && plan.method === request.method
      && pathnameMatches(plan.pathname, url.pathname)
    );
    return ws ?? null;
  }
  return plans.find((plan) =>
    plan.upgrade === undefined
    && plan.method === request.method
    && pathnameMatches(plan.pathname, url.pathname)
  ) ?? null;
}

export function slotSourceEnvironment(slot: CredentialSlotId): {
  source: "chatgpt" | "grok";
  environment: PlanEnvironment;
} {
  if (slot === "chatgpt_production") {
    return { source: "chatgpt", environment: "production" };
  }
  return { source: "grok", environment: "production" };
}

/** Documented surface grants issuable to new API keys. Each grant maps to at least one plan. */
export const ISSUABLE_SURFACE_GRANTS: ReadonlySet<string> = new Set(
  Object.values(PROVIDER_RELAY_PROFILES).map(profile => profile.surfaceGrant)
);

function pathnameMatches(pattern: string | RegExp, pathname: string): boolean {
  if (typeof pattern === "string") {
    return pattern === pathname;
  }
  return pattern.test(pathname);
}
