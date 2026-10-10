# Security policy

## Supported development and reporting

Security fixes are handled on `main`. Report vulnerabilities through GitHub private vulnerability reporting where available or a private maintainer channel. Do not disclose credentials or sensitive provider content in public issues, PRs, logs or screenshots.

Safe evidence consists of reviewed metadata: Agency Relay object IDs, request correlations, safe key prefixes, timestamps, stage names and status/error codes. Do not include token/key hashes as evidence by default, raw provider resource identifiers, temporary URLs, bearer headers, whole responses, or exported auth files.

## Authentication and authorization

Identity, roles, ownership, JIT, and offboarding follow [organization-access.md](docs/product/organization-access.md).

## Runtime grant authority

Authorization-code consumption, refresh rotation, lost-response reconciliation, and grant revocation share one Durable Object transaction. KV read-modify-write is not that authority. A repeated exchange of a code that already succeeded returns the same issued tokens when the verifier, redirect, and resource still match. A lost refresh response returns the same replacement until that replacement is itself rotated. Refresh keeps the grant account and keeps the original resource.

Revocation advances the grant generation. The next use of an old bearer or refresh is denied. A response already returned stays returned. A later allow does not revive the old bearer. Rebinding to a different account advances the generation and the account together. Rebinding to the current account is rejected. Refresh of the same account rotates credential material and leaves the account in place.

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
