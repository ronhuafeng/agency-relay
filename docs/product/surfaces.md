# Product surfaces and authority

This page owns host, grant, provider and resource-authority boundaries. Exact executable method/path registration remains in `src/plans/execution-plans.ts`; Worker host routing remains in `wrangler.jsonc`. [Organization access](organization-access.md) defines the accepted control-plane target. The provider route catalog is not expanded by that design.

## Human console and operator API

| Host/interface | Authentication | Authorization |
| --- | --- | --- |
| Dedicated `ADMIN_DASHBOARD_HOST`, currently `mini-proxy.uniweaver.com` | Feishu authorization code, then host-only session cookie | Current D1 active user, then self ownership or admin role |
| Console `/me/*` and native `/me/ui/*` | Same verified email principal | Current user only, including for an admin |
| Console `/admin/*` and native `/admin/ui/*` | Same verified email principal | Current active admin; object/lifecycle safeguards |
| `api.trustedtunnel.app/admin/*` | `Authorization: Bearer <ADMIN_SECRET>` | Restricted operator bootstrap, break-glass and recovery; not browser login |

All console browser writes require the central same-origin mutation guard. JSON mutations are not exempt. An API-host operator route must never accept the console session as a substitute; the dashboard must never accept `ADMIN_SECRET` as a login fallback.

The console session lasts 8 hours. Alternate hosts must not bypass the same Worker authentication boundary.

## Client ingress and gates

| Surface | Host | Exact issuable grant | Credential slot |
| --- | --- | --- | --- |
| Codex | `api.trustedtunnel.app` | `surface:codex:production` | `chatgpt_production` |
| Grok | `grok.trustedtunnel.app` | `surface:grok:production` | `grok_production` |
| Explicit xAI API | `xai.trustedtunnel.app` | `surface:xai:production` | `grok_production` |

Each row is one Provider profile in [`src/plans/execution-plans.ts`](../../src/plans/execution-plans.ts). A plan derives its host, grant, protocol and credential slot from that profile. Explicit xAI keeps the Grok production slot and shared-team authority. This classification does not add Runtime OAuth or a second route selector.

All use Agency Relay bearer API keys. Browser Access cookies, application role and another surface's grant never imply a client grant. No interactive login redirect is inserted into client API paths.

Admission requires a valid/unexpired key, active owning user, exact key grant, supported Execution Plan, usable stored binding, and an effective credit policy that permits the plan's charge. A personal policy overrides the organization default; a missing final policy fails closed. A finite zero cap permits otherwise-authorized zero-charge operations. See [credits](../operate/credits.md) for policy and issuance rules.

Defaults choose credentials only when a new key is issued. Runtime uses `api_key_surface_credentials`; replacements copy those bindings. Missing bindings fail closed. A default change does not silently reassign old keys.

## Codex

The declared Codex surface accepts:

- `GET /v1/models`;
- `POST /v1/responses` and `POST /v1/responses/compact`;
- `POST /v1/audio/speech` and `POST /v1/audio/transcriptions`;
- `POST /v1/realtime/calls` and `POST /v1/live`;
- WebSocket `GET /v1/realtime`, `GET /v1/live`, and `GET /v1/live/{call_id}`;
- deprecated WebSocket `GET /v1/responses`, which returns the explicit typed `426` compatibility rejection.

Models, Responses and compact use the selected ChatGPT credential through the Codex egress shim to the ChatGPT Codex backend. `CODEX_EGRESS_BASE_URL` must match the approved hostname. Speech/transcriptions/realtime/live plans target their declared OpenAI API origin with the same plan-compatible ChatGPT authority. This is the registered Agency Relay contract, not a promise about provider support beyond the proven endpoint.

Codex client voice uses Realtime/WebRTC paths rather than the two audio REST paths. Do not infer new provider support from the console service name.

## Grok

`GET /v1/models` and `POST /v1/responses` target the official CLI gateway `https://cli-chat-proxy.grok.com`. Models are forwarded directly; Agency Relay does not cache, filter, rebuild or invent a fallback catalog. Provider-reported response models may differ from requested or advertised names. The gateway catalog is not an external client's release-bundled catalog authority.

Other admitted Grok plans target `https://api.x.ai` using the bound Grok production subscription credential:

| Group | Exact paths |
| --- | --- |
| Direct tasks | `POST /v1/chat/completions`, `POST /v1/tts`, `POST /v1/stt` |
| Catalogs | `GET /v1/language-models`, `/v1/image-generation-models`, `/v1/video-generation-models`, `/v1/tts/voices` and the corresponding `{model_id}` or `{voice_id}` detail paths |
| Tokenization | `POST /v1/tokenize-text` |
| Images | `POST /v1/images/generations`, `POST /v1/images/edits` |
| Videos | `POST /v1/videos/generations`, `/v1/videos/edits`, `/v1/videos/extensions`; owner-bound `GET /v1/videos/{request_id}` |
| Files | `POST /v1/files`; owner-bound `GET /v1/files/{file_id}`, `GET /v1/files/{file_id}/content`, `DELETE /v1/files/{file_id}` |

These are exact registration families, not prefix wildcards. Generic CLI-gateway model details, xAI Responses create/retrieve/delete/compact, deferred Chat retrieval, team-wide file listing, file update, chunked upload and public-URL management are not ordinary Grok-surface contracts. An opaque Chat body may request a deferred operation, but without a supported retrieval route Agency Relay does not promise an end-to-end deferred lifecycle.

Files upload binds returned provider IDs to the creating Agency Relay user before exposing them. Video start/poll uses bounded control-response observation and HMAC-only ownership state. Storage outputs are bound only where the exact plan owns that projection; raw IDs, temporary URLs, prompts and media are not persisted. Image output expiry is not guessed across independent files. Provider 404/delete can retire a matching projection.

Owner checks protect the declared Grok Files/video routes. Opaque media request bodies are not recursively inspected: an embedded provider file ID acts as a provider capability, not a new promise of comprehensive payload-level tenant isolation.

## Explicit xAI API: shared-team authority

The xAI hostname exists because its `/v1/models` and `/v1/responses` have different semantics from the Grok CLI gateway. It uses a separate exact grant, but not a separate credential-slot type:

```text
Agency Relay key + surface:xai:production + current entitlement
 -> key's explicit xAI binding
 -> fresh Grok production subscription authority
 -> exact api.x.ai plan
```

**This surface is not per-Agency Relay-user resource-isolated.** It can list/control shared provider-team resources and obtain a derived short-lived provider credential through the admitted client-secret endpoint. Application RBAC and private `/me` pages do not change that upstream authority. Historically it was reserved for designated admin callers; the accepted organization design allows a member to request an xAI key only when an admin has deliberately enabled that member's effective xAI allowance. That allowance is an authority delegation, not merely a spending number. Initial xAI default is zero.

Changing an Agency Relay user's role or allowance cannot revoke a provider credential already derived and returned by the provider. Nor can it retroactively terminate an existing opaque WebSocket. Keep these residual boundaries visible in administrator approval and release review. Narrowing the xAI API to owner-isolated routes would be a separate product change, not an implicit consequence of RBAC.

The exact xAI allowlist is:

| Group | Methods/paths |
| --- | --- |
| Read/catalog | `GET /v1/models`, `/v1/models/{model_id}`, `/v1/language-models`, `/v1/language-models/{model_id}`, `/v1/image-generation-models`, `/v1/image-generation-models/{model_id}`, `/v1/video-generation-models`, `/v1/video-generation-models/{model_id}`, `/v1/tts/voices`, `/v1/tts/voices/{voice_id}`, `/v1/custom-voices`, `/v1/batches`, `/v1/files` |
| Inference | `POST /v1/tokenize-text`, `/v1/chat/completions`, `/v1/tts`, `/v1/stt`, `/v1/responses`, `/v1/responses/compact`, `/v1/images/generations`, `/v1/images/edits`, `/v1/videos/generations`, `/v1/videos/edits`, `/v1/videos/extensions` |
| Deferred/response/video lifecycle | `GET /v1/chat/deferred-completion/{request_id}`, `GET /v1/responses/{response_id}`, `DELETE /v1/responses/{response_id}`, `GET /v1/videos/{request_id}` |
| Files | `POST /v1/files`; `GET /v1/files/{file_id}`, `GET /v1/files/{file_id}/content`, `DELETE /v1/files/{file_id}`; `POST /v1/files/{file_id}/public-url`, `POST /v1/files/{file_id}/public-url/revoke` |
| Batches | `POST /v1/batches`; `GET /v1/batches/{batch_id}`, `GET /v1/batches/{batch_id}/requests`, `GET /v1/batches/{batch_id}/results`; `POST /v1/batches/{batch_id}/requests`, `POST /v1/batches/{batch_id}:cancel` |
| Search/derived authority | `POST /v1/documents/search`, `POST /v1/realtime/client_secrets` |
| WebSocket | `GET` with upgrade on `/v1/responses`, `/v1/tts`, `/v1/stt`, `/v1/realtime` |

All xAI plans transparently target `https://api.x.ai`. Caller credentials, CLI-only helper headers and inappropriate handshake metadata are removed; the refreshed bound bearer is injected. HTTP bodies and WebSocket frames remain opaque. Accepted sockets use the existing half-open-aware bidirectional relay. Ordinary Grok owner-binding modes are not silently applied to this hostname.

Management API, `management-api.x.ai`, custom-voice mutations, `PUT /v1/files/{file_id}` and every unlisted endpoint remain closed. Endpoint conformance is not equivalence to an official xAI API-key contract. A direct success on one endpoint never authorizes a wildcard. New plans require exact same-authority evidence before admission.

## Upstream client identity

Plan-declared compatibility identity is `codex_cli`, `grok_build`, or `none`. It never authenticates a caller, selects a credential, or changes grants.

`codex.models`, `codex.responses`, and `codex.responses_compact` select `codex_cli`. `grok.production.models` and `grok.production.responses` select `grok_build`. Direct xAI-backed Grok plans, xAI API plans, Codex speech/transcriptions/realtime/live and the local Codex WebSocket rejection select `none`.

A native Codex bundle includes official Originator/User-Agent and, for models, one matching client version. A Grok bundle includes matching version, identifier and User-Agent; optional client mode must be interactive or headless. Preserve a complete native bundle as a group, including older versions. Remove mixed/conflicting/incomplete bundles together and use only the reviewed stable-channel fallback when a valid adopted version exists. Never combine caller and fallback identity fields. Invalid channel candidates cannot replace a valid stored version; channel movement alone cannot change the reviewed wire shape.

## Observation and bytes

Each plan explicitly declares `responses`, `image`, `video`, or `none`. Do not infer metering from hostname. Direct Chat/TTS/STT, catalogs, Files and other opaque plans do not acquire token/media measurement by being exposed in a user dashboard.

Responses metadata enters `usage_daily`; image/video measurement enters `media_usage_daily`. Video terminal accounting stays exactly once. xAI image outputs do not acquire ordinary Grok owner binding; xAI video identifiers may be HMAC-held for accounting without becoming an authorization gate.

Observation failure leaves coverage unknown and cannot replace the client result. Preserve status, response bytes and encoding outside plan-owned safety rules; leave re-encoding to the Workers runtime rather than incorrectly marking decoded bytes manually compressed. The client-secret response is an intentional provider-secret delegation exception, remains opaque, and is never logged as content.

Details: [usage](../operate/usage.md), [Responses development](../develop/responses.md), and the exact source/test catalog.

## Non-product ingress and health

Staging hostnames are not product ingress; subscription environment remains metadata where present. Antigravity, Claude and Gemini are not added by this design. `GET /healthz` on Worker/egress proves process liveness only, not organization admission, credential readiness, catalogs or a completed task.
