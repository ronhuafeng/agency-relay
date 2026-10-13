# Security policy

## Supported development and reporting

Security fixes are handled on `main`. Report vulnerabilities through GitHub private vulnerability reporting where available or a private maintainer channel. Do not disclose credentials or sensitive provider content in public issues, PRs, logs or screenshots.

Safe evidence consists of reviewed metadata: Agency Relay object IDs, request correlations, safe key prefixes, timestamps, stage names and status/error codes. Do not include token/key hashes as evidence by default, raw provider resource identifiers, temporary URLs, bearer headers, whole responses, or exported auth files.

## Authentication and authorization

Identity, roles, ownership, JIT, and offboarding follow [organization-access.md](docs/product/organization-access.md).

## Runtime grant authority

Runtime is not yet a production route. The synthetic integration uses the pinned
`@node-oauth/oauth2-server@5.3.0` token engine, Workers compatibility date
`2026-06-24`, `nodejs_compat`, and one SQLite-backed Durable Object transaction.
The unmodified library owns token request validation, PKCE verification and token
generation; Agency Relay's model owns resource binding, grant generation and
atomic storage. The real client proof uses Codex CLI `0.156.1`, including a
protected tool-catalogue read and denial after revocation. It does not use a model
or Stitch credential.

Authorization-code consumption, refresh rotation and grant revocation share that
transaction. Expected protocol rejection commits consumption or replay revocation;
an unexpected/storage failure rolls the transaction back. An authorization code
is single-use, as required by [RFC 6749 section 4.1.2](https://www.rfc-editor.org/rfc/rfc6749#section-4.1.2).
Code replay is rejected and invalidates its grant, not another grant. Refresh
rotation also rejects replay and invalidates that grant's active credentials,
following [RFC 9700 section 4.14.2](https://www.rfc-editor.org/rfc/rfc9700#section-4.14.2).
A lost successful token response does not permit a second successful exchange;
the client must obtain fresh consent. A wrong PKCE verifier consumes the code,
matching the pinned library's policy. Refresh preserves the account, exact
resource and granted scope, and cannot add scope.

KV read-modify-write is not the authority. The inspected
`@cloudflare/workers-oauth-provider@1.2.3` uses `env.OAUTH_KV` and does not supply
this transaction seam. No KV emulation or OAuth library fork is introduced.
The production OAuth owner is `src/runtime/oauth.ts`, with HTTP roles in
`src/runtime/authorization.ts`. Synthetic identity and MCP tasks establish the
controlled contract, not deployed Feishu or Stitch capability. Empty Runtime
declarations publish neither an installation nor its OAuth endpoints.

Revocation advances the grant generation. The next use of an old bearer or refresh is denied. A response already returned stays returned. A later allow does not revive the old bearer. Rebinding to a different account advances the generation and the account together. Rebinding to the current account is rejected. Refresh of the same account issues new refresh and access material and leaves the account in place. A previously issued access token remains usable only until expiry, grant replay invalidation or a generation change.

### Runtime admission and lifecycle

V1 selects one dedicated SQLite-backed OAuth Durable Object for the organization,
separate from Provider TokenAuthority. It owns registered clients, pending
transactions, Client Consent, authorization codes, token families and replay
tombstones. The pinned library supplies protocol validation and credential
generation through its model interface; application consent, exact resources and
current entitlement remain Agency Relay policy. Production authorization-code
issuance uses the library's authorize/model seam. The earlier synthetic consent
handler is not an alternate production authorization server.

One short `blockConcurrencyWhile` gate serializes grant reads/mutations while a
current D1 primary read is in flight. This is necessary because awaiting external
D1 I/O alone does not prevent a consent revocation from interleaving. Inside that
gate, validate the credential and current consent, then perform one joined D1
authority read and compare the captured access and Authority Revisions. For a
successful request, that D1 snapshot is the admission point. A grant revocation
cannot commit in the DO during this gate; a D1 revocation that commits before the
snapshot is observed and denies admission. A later revocation does not undo an
already admitted request. Missing/failed reads deny access. The gate is bounded
to five seconds and never contains upstream I/O or a response stream.

Use a direct D1 binding read or the first query of a fresh
`withSession("first-primary")` session, never a reused session/bookmark that can
select an older replica. This follows the documented
[D1 primary-read contract](https://developers.cloudflare.com/d1/best-practices/read-replication/#start-a-session-with-all-latest-data)
and [DO concurrency gate](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile).
D1 and DO still do not share a transaction: an OAuth result that overlaps a later
D1 revocation can be returned, but cannot authorize the next request under the
changed revisions. Short-lived consent captures authority when created and
revalidates the same revisions on Allow and token exchange, not a later authority
substituted after login.

The production target uses ten-minute access tokens, two-minute authorization
codes, and a thirty-day absolute token-family lifetime. Refresh never extends
that family deadline. Pending login/consent transactions expire after ten
minutes. Keep consumed-code and spent-refresh tombstones until the family ends;
individual credential expiry is not a safe deletion boundary while descendants
are valid. Revoke/replay blocks the whole affected family immediately. Alarm
cleanup selects at most 128 ended families after the ten-minute retention
margin and limits each child-record deletion to 256 rows. It retains each
family until all its child records are removed. Delay or failure consumes storage but
cannot restore authority. Resource reads always check expiry and revision;
cleanup is not the expiry mechanism.

An unused registration expires after twenty-four hours. A registration with live
consent is retained through its last token-family deadline. Expired IDs are never
reissued, and a new registration needs fresh consent. The selected V1 caps are
100 registrations organization-wide and five live client consents per
member/installation. At capacity, reject new work; do not evict active grants.
Registration attempts use a durable organization limit of 100 per UTC hour;
token attempts use 30 per registered client per UTC minute, with an organization
limit of 300 per minute covering unknown clients too. Revocation cannot reset
these counters. Public request limits include malformed registration/token
traffic; an unambiguous registered client ID also consumes its per-client token
limit before the remaining form is validated. Authorization starts are limited
to 300 per organization and 30 per client per UTC minute, with at most 300 pending
transactions. Protocol bodies are limited to 8 KiB and a five-second read budget.

No CIMD, JWKS fetch, third-party registration metadata fetch, automatic consent,
or persistent MCP session is selected for V1. DCR allocates an independent public
client ID for each registration; the synthetic fixture's one fixed client ID is
not the production registration policy. Scope grants installation use, not
per-tool read-only access. A consent screen must state the shared upstream
authority consequence. All token material stays out of audit and diagnostics.

The canonical console origin owns `/.well-known/oauth-authorization-server`,
`/runtime/register`, `/runtime/authorize`, `/runtime/token`, the exact opaque
`/runtime/consent/:id` return, and current-member `/runtime/clients` list/revoke.
Each deployment-declared resource origin owns
`/.well-known/oauth-protected-resource/mcp`; the resource itself is the exact
HTTPS `/mcp` URI. A resource origin cannot also be a Provider or console origin.
Registration and token exchange require no browser cookie/Origin; their explicit
uncredentialed CORS never advertises credentialed wildcard access. Consent and
client revocation use the existing console principal and exact-Origin write guard.
Only an opaque browser-bound, ten-minute transaction can survive Feishu return.
An authenticated pending transaction captures both authority revisions; an
anonymous start captures installation authority before login, then member access
when that verified identity first enters consent. Neither can adopt a newer
installation authority after rebind.

Tokens are opaque: the dedicated OAuth authority looks up their domain-separated
HMAC, expiry, exact resource and actual granted `runtime.use` scope. Provider
keys, upstream tokens, operator secrets and console cookies are not Runtime
bearers. Missing/invalid tokens receive a resource-metadata challenge; current
permission loss receives 403 and unavailable authority receives 503. Own consent
metadata is not a cached entitlement. DCR allocates a new public client ID and
does not update an older registration. Unsupported self-asserted metadata is
ignored without fetching it, as required by [RFC 7591 §2](https://www.rfc-editor.org/rfc/rfc7591.html#section-2);
client-secret and JWK-based registration are rejected.

Keep automatic invocation logs and traces off for this Worker. Cloudflare's
[invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs)
include URLs, and [trace attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/)
include full URLs/query strings and Durable Object SQL bindings. Application
logs remain enabled for allowlisted event categories, never callback queries,
credentials or raw client metadata. No-store and no-referrer apply to OAuth
responses. Consent HTML blocks framing and permits form return only to the
validated callback origin. Do not collect raw OAuth traffic with live tail,
browser tracing or diagnostics.

## Browser protection

Guard every console-session state-changing request, including JSON POST/PUT/PATCH/DELETE and native UI POST forms, with exact canonical same-origin verification and cross-site Fetch Metadata rejection. Missing/invalid Origin is rejected on the browser-only write interface. Confirmation dialogs and SameSite assumptions do not replace the guard. The operator bearer API is a distinct non-cookie boundary.

Validate the Worker-side session and host boundary. An alternate Worker URL must not bypass authentication or expose sensitive console data.

The administrator console nonce-binds scripts and stylesheet elements. Inline
style attributes are allowed for standard UI control geometry and hidden form
inputs; they do not permit inline executable scripts or external stylesheets.

Use private/non-cacheable responses for console data and one-time key results. Never cache privileged HTML, identity responses or key material in service workers, shared caches, history payloads, local storage or analytics. Clear transient sensitive content on logout/page restoration. A lost mutation response is uncertain, not permission for blind replay.

## Keys and credentials

Return a new Agency Relay key plaintext once; persist only its prefix and HMAC and use timing-safe verification. Hashes and peppers are not public metadata. New/replacement keys have bounded validity and family/overlap limits; legacy metadata exceptions never exempt a key from status, grant or allowance checks.

Normal members cannot see or choose internal credential accounts. New-key defaults are resolved server-side and stored as sticky key/surface bindings. Runtime must not silently choose a latest/default fallback. Validate compatibility and usability, and create the complete key/binding set atomically.

Provider secrets stay encrypted in TokenAuthority; D1 holds only allowed metadata. Admin endpoints must not return raw shared token material. Upstream OAuth material, callback codes and refresh responses never enter saved drafts or audit. The browser console does not accept manual provider tokens/auth files.

Retirement with live bindings requires explicit migration, impact acknowledgement and confirmed cleanup. Forced disconnection is a protected break-glass operation. D1 and TokenAuthority are separate effect boundaries; a partial cleanup must not restore retired authority or be presented as success.

## Admission and residual provider authority

Effective allowance is personal override, then organization default, then zero. Disabled-surface checks apply to zero-charge plans too. Database failure is not Unlimited. Atomic admission prevents concurrent overspend of Agency Relay credits, but those credits are not a hard provider-cost budget.

The explicit xAI surface deliberately delegates shared provider-team authority. It does not isolate provider resources per relay user and includes derived client-secret creation. Console RBAC does not prevent an authorized xAI caller from acting on those team resources. Initial xAI allowance is zero; any positive delegation requires administrator understanding of [the surface boundary](docs/product/surfaces.md).

Disabling a user rejects subsequent Agency Relay authorization/admission. It does not retroactively cancel already-admitted operations, close every opaque WebSocket, or revoke a provider-derived credential already returned outside Agency Relay. Offboarding also requires removing Feishu app availability and, where necessary, permanent Agency Relay-key/provider-side revocation.

## Secret and evidence handling

Store Worker secrets in secret bindings, never source. Production operator values may live in ignored root `.env`; local-only Worker secrets belong in ignored `.dev.vars` and must not copy production values. Never make `.env`, `.dev.vars`, `.wrangler`, `auth.json`, local `.codex` state, `worker-secret.json`, `local-secrets`, private keys or tunnel tokens Git-visible. The only `.codex` exception is `.codex/config.toml`, which maps credential headers to host-local environment variables and contains no credential values. Never commit development or production credentials. Use the existing `pnpm run scan:git-artifacts` for relevant artifact work.

Canonical mutation audit records only allowlisted metadata, actor identity/role snapshots, targets and results. No keys, key hashes, tokens, passwords, prompt/output content, raw SSE, media, whole bodies or OAuth callbacks. Success audit and D1-owned state should commit together; rejected conditional writes must not leave false success records.

Egress must never log Authorization, `X-Codex-Egress-Secret`, request/response bodies or provider token material. Header Provenance Manifest evidence contains normalized header names only; remove the egress secret and manifest before the backend request.

The only intentional provider-secret response exception is the explicitly delegated xAI client-secret endpoint, whose response remains opaque and unlogged. It is not permission to expose Agency Relay-held credentials elsewhere.

## Release safety

Before admitting the organization through Feishu, prove ordinary users cannot reach any admin surface. Rollback must not restore login-equals-admin or missing-policy-Unlimited. Code rollback does not roll back D1, secrets, revoked keys or TokenAuthority. Follow [the release runbook](docs/operate/release.md).
