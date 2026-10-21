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

Canonical Codex ingress on `api.trustedtunnel.app` uses these exact registered Execution Plans. Registration defines transport routing, not proof of a successful provider business outcome:

- `GET /backend-api/codex/models` → shim `/models` → `https://chatgpt.com/backend-api/codex/models`;
- `POST /backend-api/codex/responses` → shim `/responses` → `https://chatgpt.com/backend-api/codex/responses`;
- `POST /backend-api/codex/realtime/calls` → shim `/realtime/calls` → `https://chatgpt.com/backend-api/codex/realtime/calls`;
- `POST /backend-api/codex/live` → shim `/live` → `https://chatgpt.com/backend-api/codex/live`;
- `POST /backend-api/transcribe` → shim `/transcribe` → `https://chatgpt.com/backend-api/transcribe`.

Transcription is that separate native path. It is not `/backend-api/codex/audio/transcriptions`. WebSocket `GET /backend-api/codex/responses` stays the typed `426` rejection. The HTTP shim does not forward Upgrade, and Agency Relay does not carry WebRTC UDP.

Previously configured clients may still call the same operations at the exact legacy paths `GET /v1/models`, `POST /v1/responses`, `POST /v1/realtime/calls`, `POST /v1/live`, and `POST /v1/audio/transcriptions`. Those paths are aliases onto the canonical plans. The alias copies method, query, headers and body unchanged. It does not convert a public-API JSON body into a ChatGPT backend body, and it does not make an old `/v1` client select backend-only request shapes. WebSocket `GET /v1/responses` aliases to the same `426`. Any other method or Upgrade on an aliased path fails closed with the canonical plan's method rule.

Verified end-user capability scope excludes `POST /backend-api/codex/live` and `POST /backend-api/transcribe`, including their exact legacy aliases. These retained opaque transports have no verified producer/wire contract or successful terminal business result. Do not present route registration as verified Live creation or file transcription support. Current Codex backend WebRTC sessions use `realtime/calls`, including FramelessBidi sessions; the non-backend Live branch does not establish a ChatGPT backend Live contract.

Unregistered host/method/path/Upgrade combinations fail closed without a Provider Attempt or Credit charge. This does not require body validation or conversion for retained opaque transports.

These Codex paths are not plans and must not reach a provider or a ledger charge: `POST /v1/audio/speech`, WebSocket `GET /v1/realtime`, WebSocket `GET /v1/live`, WebSocket `GET /v1/live/{call_id}`, and native-looking copies such as `/backend-api/codex/audio/speech`. No Codex plan uses `api.openai.com`. Native ChatGPT Realtime WebSocket and subscription speech remain unproven; they are not implemented here.

New Codex setup files, console downloads and examples use only `https://api.trustedtunnel.app/backend-api/codex`. Grok and xAI stay on their own `/v1` origins. A `base_url` ending in `/backend-api/codex` is necessary for Codex to choose the ChatGPT realtime JSON shape, but it is not sufficient for every first-party gate. Codex `supports_codex_backend_routes` also requires provider name `OpenAI`, and `uses_codex_backend` requires a compatible auth mode without `experimental_bearer_token`. Generated setup keeps `name = "Agency Relay Codex"` and `experimental_bearer_token` so Agency Relay API keys keep working. That combination does not advertise full first-party Codex fidelity.

Models and Responses use the selected ChatGPT credential through the Codex egress shim. The ChatGPT backend has no `/responses/compact` path. Context compaction is a `compaction_trigger` input item on canonical `POST /backend-api/codex/responses`. `CODEX_EGRESS_BASE_URL` must match the approved hostname. Realtime call creation, Live call creation and transcription use the same ChatGPT credential. Bodies stay opaque.

Codex client voice uses Realtime/WebRTC call creation rather than a speech REST path. Do not infer new provider support from the console service name.

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

`codex.models` and `codex.responses` select `codex_cli`. `grok.production.models` and `grok.production.responses` select `grok_build`. Direct xAI-backed Grok plans, xAI API plans, Codex transcriptions/realtime/live and the local Codex WebSocket rejection select `none`.

A native Codex bundle includes official Originator/User-Agent and, for models, one matching client version. A Grok bundle includes matching version, identifier and User-Agent; optional client mode must be interactive or headless. Preserve a complete native bundle as a group, including older versions. Remove mixed/conflicting/incomplete bundles together and use only the reviewed stable-channel fallback when a valid adopted version exists. Never combine caller and fallback identity fields. Invalid channel candidates cannot replace a valid stored version; channel movement alone cannot change the reviewed wire shape.

## Observation and bytes

Each plan explicitly declares `responses`, `image`, `video`, or `none`. Do not infer metering from hostname. Direct Chat/TTS/STT, catalogs, Files and other opaque plans do not acquire token/media measurement by being exposed in a user dashboard.

Responses metadata enters `usage_daily`; image/video measurement enters `media_usage_daily`. Video terminal accounting stays exactly once. xAI image outputs do not acquire ordinary Grok owner binding; xAI video identifiers may be HMAC-held for accounting without becoming an authorization gate.

Observation failure leaves coverage unknown and cannot replace the client result. Preserve status, response bytes and encoding outside plan-owned safety rules; leave re-encoding to the Workers runtime rather than incorrectly marking decoded bytes manually compressed. The client-secret response is an intentional provider-secret delegation exception, remains opaque, and is never logged as content.

Details: [usage](../operate/usage.md), [Responses development](../develop/responses.md), and the exact source/test catalog.

## Runtime MCP authorization

Provider profiles above do not admit an MCP client. A Runtime client presents a resource-bound OAuth bearer to one exact resource. That grant is separate from an Agency Relay API key, a console session, and a Provider credential.

The canonical console origin owns the OAuth issuer role. Deployment-declared MCP
resources use origins separate from the console and Providers, in the same Worker.
Exact discovery and
OAuth paths are listed in [Security](../../SECURITY.md#runtime-admission-and-lifecycle).
Public registration and token routes stay outside the console browser-write
guard. Consent and own-client revocation stay inside it; administrator Authority
Rebind remains the installation control operation, not a public OAuth route.
[Organization access](organization-access.md) owns that guard. Empty declarations
keep the OAuth surface closed. Protected MCP forwarding is a separate transport
boundary, not established by discovery or token issuance.

Each protected resource is the exact deployment-declared installation URI. A
descendant path is a different resource. A bearer for one resource is rejected
by another. Production admission enforces the actual `runtime.use` consent for
installation use, not per-tool read-only authority. Advertising a scope does not
enforce it. Browser, Provider and operator credentials cannot replace that bearer.

Discovery advertises only the authorization-code response, authorization-code
and refresh-token grants, PKCE `S256`, and public-client authentication `none`.
Registration accepts one redirect URI and allocates an independent client ID;
it cannot replace an older registration. An HTTP loopback redirect on
`127.0.0.1`, `localhost`, or `::1` may change only its port. The verifier has
43–128 characters. Registration rejects client-secret/JWK authentication and
does not fetch unrecognized metadata. Production grant limits, protocol body
bounds and cleanup are owned by [Security](../../SECURITY.md#runtime-admission-and-lifecycle).
Synthetic identity, task output and controlled clocks are test inputs, not live
Feishu, upstream capability or transport-capacity evidence.

The canonical Stitch resource is `https://mcp.trustedtunnel.app/google-stitch`.
Runtime resources use one explicitly declared lowercase letter-led path segment
(letters, digits and hyphens, at most 64 characters). Distinct installations can
share an origin; exact full-URL matching selects the installation, not the first
declaration on that host. No prefix matching, alias or trailing-slash redirect
expands the resource. Its OAuth metadata is published at
`https://mcp.trustedtunnel.app/.well-known/oauth-protected-resource/google-stitch`,
and an unauthenticated request receives a challenge for that exact document.
The resource URL is a stable authorization identity, not a mutable display name.

The relay implements request-scoped POST to the exact resource. The reviewed
`google.stitch` profile fixes the complete upstream URL to `https://stitch.googleapis.com/mcp`
and injects the exact admitted secret version as `X-Goog-Api-Key`. No incoming
path, query, body, header or client version selects that URL or credential.
No query is allowed. A present Origin must equal the resource origin.

The supported envelope headers declare `2024-11-05`, `2025-11-25`, or `2026-07-28`.
Any other `Mcp-Protocol-Version` is rejected before dispatch. An absent version
during initialization is forwarded, not synthesized. The
2025 compatibility subset forwards initialize and notifications but supports
only stateless POST exchanges. Modern requests do not need a relay-owned
initialize step. Agency Relay does not compare JSON-RPC bodies with headers,
validate tool parameters or translate negotiated versions. The upstream owns
those semantics. This is not full compatibility with every feature of either
version.

GET/DELETE, Upgrade, `Mcp-Session-Id` and `Last-Event-ID` are unsupported.
They cannot authenticate or resume a session. An upstream session header is
rejected rather than exported as a working handle. A profile requiring persistent
session or resumability must not be enabled under this contract. Opaque
application handles still carry shared upstream authority, not per-member object
isolation.

Request projection preserves content negotiation/encoding, `Mcp-Protocol-Version`,
`Mcp-Method`, `Mcp-Name` and `Mcp-Param-*`, except connection-owned hop fields.
All other request headers are removed before credential injection. Response
projection permits content type/encoding/language, the three named MCP headers
and Retry-After; custom headers, cookies, credentials, redirects and upstream
authentication challenges are not exported. A response whose complete forwarded
bytes are at most 64 KiB carries `Content-Length` equal to that exact count.
An upstream length is not copied. A longer or still-open body stays a
pull-driven stream and has no `Content-Length`. Responses are no-store. JSON/SSE
bytes and SSE envelopes remain opaque, with Workers-owned re-encoding rather
than manual compression marking.

Upstream 3xx is rejected as 502 without following Location. Upstream 401/403 is
mapped to 502 `upstream_credential_unavailable`, without its body/challenge or
an Agency Relay OAuth re-login instruction. An absent/failed exact secret read
returns 503 before dispatch. Other upstream statuses and bodies are preserved.
The downstream OAuth challenge remains exclusively the admission owner's rule.

The V1 transport envelope is a streamed request of at most 8 MiB, a
sixty-second idle upload/header/response-read limit, and a ten-minute admission lease.
There is no aggregate response-byte cap or JSON parse. The Worker cancels its
relay at lease expiry or client disconnect and releases admission on EOF/error;
it does not claim that the upstream tool action was undone. The OAuth authority
owns at most four outstanding leases per member/installation and sixteen per
installation, without holding response streams. Expired leases are removed
before admission; recovery cannot reuse a lease or replay an upstream request.
The idle read timer runs while a read waits, not while downstream backpressure
withholds a pull. The absolute lease still bounds that hold. A declared oversize
Content-Length rejects before dispatch; an unknown-length upload can be stopped
after partial delivery. It cannot undo a tool action. Each admitted HTTP request
has at most one relay dispatch; client retry is a distinct request, not exactly-once
execution. Provider Responses limits remain unchanged.

The request path uses one primary D1 authority snapshot, one OAuth admission
transaction with capacity reservation, one exact secret-owner read and one terminal
release. Terminal recording is background work and cannot pull ahead or delay
close/cancel. The OAuth owner retains only the newest admitted request's completed
transport facts per member/installation, with a thirty-day cleanup horizon:
client authorization
reference, profile/Authority Revision, attempt/status/category, timings and observed
byte counts. These counts describe stream chunks seen by Agency Relay, not encoded
network volume or provider billing. Older delayed completion cannot replace newer
facts. Cleanup can be delayed. Failed recording stays unknown; stale leases expire. No per-event write,
tool count, semantic success, token/cost measurement or Provider ledger entry is
created. HTTP 200 or clean SSE EOF is not a tool outcome.

The second fixed profile exists only in the synthetic Worker fixture and uses this
same core. It proves the extension seam and isolation, not another vendor's behavior.
Deterministic/native-client evidence is separate from deployed latency, capacity,
Feishu and a real Stitch task. Empty deployment declarations remain closed.

Codex may still authenticate to the existing Provider surface with a static API key or access token. Those Provider plans stay unchanged.

The grant authority is one Durable Object transaction, as stated in [Security](../../SECURITY.md). Source availability does not activate a production installation or call Stitch.

## Non-product ingress and health

Staging hostnames are not product ingress; subscription environment remains metadata where present. Antigravity, Claude and Gemini are not added by this design. `GET /healthz` on Worker/egress proves process liveness only, not organization admission, credential readiness, catalogs or a completed task.
