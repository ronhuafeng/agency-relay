# Credential and key operations

This runbook owns credential bindings, defaults and retirement operations. [Organization access](../product/organization-access.md) owns identity and key-lifecycle policy. Current source and bounded deployment evidence establish which operations are implemented; a documentation merge does not deploy them.

## Separate identities

A member logs in through Feishu. Agency Relay keeps a host-only session for the verified organization mailbox. A Agency Relay API key authenticates a client. A provider credential authenticates Agency Relay upstream. `ADMIN_SECRET` is the protected non-interactive bootstrap/recovery identity. None is interchangeable with another.

Normal human administration uses the Feishu console session plus an active D1 admin role. On `https://api.trustedtunnel.app/admin/*`, the operator credential is `Authorization: Bearer <ADMIN_SECRET>`; a console session does not authorize that API. Never use the operator bearer as a dashboard fallback or a member client key.

The browser console supports upstream OAuth and account management, not uploaded auth/session files or manually pasted provider token values. Restricted operator import is a recovery interface. Keep provider secrets encrypted in TokenAuthority and outside D1 public projections, browser responses and logs.

## Bootstrap and member lifecycle

Promotion, email change, offboarding, and JIT follow [organization-access.md](../product/organization-access.md).

## Provider binding model

```text
API key + exact surface grant
 -> stored credential-account binding
 -> Execution Plan credential slot
 -> fresh encrypted TokenAuthority state
 -> isolated provider attempt
```

The plan owns the slot type; the stored binding selects one physical account. Clients cannot select an origin or override an account. A request does not choose the latest account or organization default.

## Runtime installations

Runtime deployment binds one MCP Custom Domain and sets its HTTPS origin in
`RUNTIME_MCP_ORIGIN`. If that origin is absent, Runtime stays closed unless
legacy exact `RUNTIME_INSTALLATIONS` are declared. Legacy declarations keep
their fixed paths. Cloudflare owns the host and certificate. D1 owns the
paths, enablement and access for Google Stitch and Feishu Docs on the configured
MCP origin.

In **Tool services**, choose a connector and create its configuration with an
unused path. Paths consist of a slash and one lowercase letter-led segment
(letters, digits and hyphens, 64 characters maximum). `/healthz` is reserved.
Bind a credential, enable the service and grant access to eligible members.

The credential request header defaults to `X-Goog-Api-Key` for Stitch and
`X-Lark-MCP-TAT` for Feishu Docs. Use the rebind form to change the header and
save the corresponding credential together. Credentials are write-only. For
Feishu Docs, enter the dedicated application's App ID and App Secret. The relay
obtains and caches an application token (TAT) on demand and renews it near
expiry. Each credential version has its own cache. Automatic token renewal
preserves Relay OAuth consent. Saving a different credential or header in the
Feishu form is a rebind and requires fresh client consent.

In **Tool services → Feishu Docs → 飞书工具**, select the tools to enable.
The console groups the tools published for the hosted endpoint
`https://mcp.feishu.cn/mcp` by operation and shows their Feishu application
scopes. The [OpenAPI MCP repository](https://github.com/larksuite/lark-openapi-mcp)
defines a broader catalog for its own server. Publish the corresponding scopes
in the Feishu app for the identity you intend to use. Initially, document search, document reading
and member search are enabled. Save changes in Relay to apply them to later
admissions. Grant added tools to a client through a new client consent.

The Feishu tool tree uses the same MCP URL and shows the pinned upstream
`AllToolsZh` catalog. Search by API name, business domain, or scope. Group
checkboxes select the matching tools while a search is active. Save the
complete selection once. Relay enables JSON endpoints when the tool definition matches a
documented permission and supported identity. Entries without that evidence and
tools that need custom SDK or file handlers remain visible without enable
controls. To rebuild the pinned catalog, run
`pnpm exec tsx scripts/update-feishu-openapi.ts`. Add `--read-api-docs`
to refresh the per-method scope evidence from public Feishu API documents.

For member authorization, register
`https://<console-host>/runtime/feishu-user/callback` as an OAuth redirect URL
in the bound Feishu app. Publish `contact:user.email:readonly`,
`contact:user.employee:readonly`, `offline_access` and the user scopes for the
enabled tools. Include the members in the app's availability range. Enable
user token refresh if Feishu exposes that setting. Members connect or update
their Feishu authorization under **My tool services → Feishu Docs**, then approve
the tool list in their MCP client's existing login flow.

Relay prefers UAT when it carries the tool's required scopes. A dual-identity
tool may use TAT when the member token lacks those scopes. An existing binding
with a manual TAT supports application-capable tools until that token expires.
Feishu still checks object permissions for the selected identity. Relay refreshes
each member's token on demand and stores the rotated tokens encrypted.
For OpenAPI calls with TAT, Relay checks the scopes returned by the OAuth
client-credentials exchange. A manual TAT does not supply scope evidence for
OpenAPI tools. It remains usable for eligible hosted MCP tools.
Reconnect when Feishu no longer accepts renewal. See
[Feishu remote tools and permissions](https://open.feishu.cn/document/mcp_open_tools/developers-call-remote-mcp-server)
and [Feishu user token refresh](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3).

Updating a path closes the old URL and invalidates client consent for that
installation. The old path stays reserved. Members retain administrator-granted
access and must update the URL and authorize the client again. Changing the
authentication header or binding a different upstream authority also invalidates
consent. Use the operator API for an explicit future member access expiry.

Native Runtime forms allow 16 KiB for percent encoding a valid 4096-byte credential.
The Feishu installation form allows 128 KiB for the full list of tool IDs.
The decoded credential limit stays the same.

After an uncertain HTML operation, use its read-only recovery link. The `writing`
state offers explicit abort-and-disable; `cleaning` offers exact cleanup recovery.
Both require the current revision and original pending operation ID. A known write
stays known when a subsequent page read fails. Do not reload a native POST to seek
another result. Production activation still requires the Runtime release issue's
separate domain, fresh credential and operator authority.
An expired console session rejects the native form before reading its body or
performing the operation. Its login link retains only the owning read-only page;
sign-in does not replay the rejected POST.

| Operation | JSON endpoint |
| --- | --- |
| Declared inventory / one installation | `GET /admin/runtime-installations` / `GET /admin/runtime-installations/:id` |
| Configure, change path, enable, disable, rename, supply, retire, recover | `POST /admin/runtime-installations/:id` |
| Read / grant / revoke human access | `GET/PUT /admin/runtime-installations/:id/access/:user_id` |
| Reconcile a known operation | `GET /admin/runtime-installations/:id/operations/:operation_id` |

`configure` takes `action` and optionally `path` and creates disabled metadata.
Legacy exact installations take `action` alone. Other installation
commands take `action`, `expectedRevision` from a fresh read and a new
`operationId` (1–96 ASCII letters, digits, `_` or `-`). `rename` also takes `label`.
`path` takes the proposed `path`. `supply` takes write-only `material`, an optional
`credentialHeader` and `authority`. Feishu rebind also accepts `appId` and
`appSecret` in place of `material`. `same` is an explicit
administrator declaration that the upstream account/workspace is unchanged;
use `rebind` for a new header or upstream authority. Initial supply is a rebind.
Credential headers use `X-` names or `Api-Key`. Reserved forwarding, routing
and connector policy headers are rejected. Material must be a nonempty printable ASCII header value, at most 4096
bytes. JSON bodies are limited to 8192 bytes; extra fields are rejected.

Access PUT takes `state` (`granted` or `revoked`), `expectedRevision` (zero for an
absent relation) and `expiresAt` (null or a future canonical UTC timestamp). It
does not issue OAuth consent. Role, Provider credits and browser login do not
grant Runtime access. Access revisions survive revocation and human re-enable.

Credential operations reserve a D1 revision, write an encrypted candidate to the
separate per-installation `RuntimeCredentials` SQLite Durable Object, conditionally
bind it, then clean obsolete versions. `writing` and `cleaning` deny admission.
The configured `state` is not readiness: check `phase` and `credential_ready`.
`disable` preserves the bound credential but invalidates consent; `retire` also
clears it and cannot be undone. A previously admitted request may finish.

After a lost response, read the installation and operation stages; never resend
secret supply blindly. `recover` requires the current revision and the pending
operation ID. For `cleaning`, it retries the exact cleanup and confirms readiness.
For `writing`, it explicitly aborts the unknown candidate, disables the
installation and clears **all** versions. Supply a new credential afterwards.
A stale completion cannot restore a newer disabled or retired state. Metadata
and successful stage audit share a SQL transaction; D1 and DO do not.

Runtime encryption uses a domain-separated HMAC subkey from
`TOKEN_ENCRYPTION_KEY_V1`, bound to the installation and immutable version, then
AES-GCM. It does not change Provider encryption or TokenAuthority identities.
Neither metadata nor operation receipts return material or encrypted blobs.
The additive D1 schema and new DO binding follow the normal release procedure;
Worker rollback does not remove them or restore retired authority.

ChatGPT production accounts are compatible with `surface:codex:production` / `chatgpt_production`. Production Grok accounts are compatible with `surface:grok:production` and `surface:xai:production` / `grok_production`. There is no separate official xAI API-key slot. Endpoint compatibility and upstream subscription authority remain exact-plan facts.

## Existing operator account endpoints

| Action | ChatGPT | Grok |
| --- | --- | --- |
| List/create | `GET/POST /admin/codex-auths` | `GET/POST /admin/subscriptions` |
| Read selected ChatGPT account | `GET /admin/codex-auths/:id` | Use existing subscription inventory/detail service |
| Begin OAuth | `POST /admin/codex-auths/:id/oauth/start` | `POST /admin/subscriptions/:id/oauth/start` |
| Complete OAuth | `POST /admin/codex-auths/:id/oauth/complete` | `POST /admin/subscriptions/:id/oauth/complete` |
| Pause / resume admission | `POST /admin/codex-auths/:id/pause` / `POST /admin/codex-auths/:id/resume` | Not supported |
| Refresh | `POST /admin/codex-auths/:id/refresh` | `POST /admin/subscriptions/:id/refresh` |
| Disconnect | `DELETE /admin/codex-auths/:id` | `DELETE /admin/subscriptions/:id` |

ChatGPT creation takes a safe label; Grok creation also specifies `capability_source=grok` and `environment=production`. Creation without credential material is not readiness. OAuth callbacks/state and token values never belong in audit or saved drafts. Refresh changes token/expiry, not member keys, grants or configuration.

An expired access token with refresh capability is not automatically a revoked account. Conversely, a compatible database row is not enough to prove usability. New default selection and issuance must consider the current credential state and fresh-token path, without claiming a prior test guarantees future availability.

The administrator console's `GET /admin/events/credentials` WebSocket sends only invalidation messages after credential metadata commits. `GET /admin/credential-status` reads safe local state without refreshing tokens or probing providers. Both require a current administrator console session; the operator bearer and member sessions cannot subscribe. The channel uses the separate `CREDENTIAL_EVENTS` Durable Object binding and `v2-credential-events` migration. It rechecks session authority before notifications and on a one-minute alarm; reconnect and browser polling recover missed events. Notification delivery failure does not change a credential operation's outcome. Deploy the binding and migration with the Worker under the [release procedure](release.md); local checks do not establish deployed connectivity.

## Pause one ChatGPT account

Pause and resume require an administrator Console session or the protected
operator API, an exact ChatGPT account ID, and `confirm=1`. They set an independent
`admission_state` (`paused` or `enabled`), never the provider credential `status`.
Read the returned account and its admission state to confirm the committed result;
`GET /admin/codex-auths/:id` is the operator recovery read. Repeating the same
set-state command is safe and records another metadata-only operator command audit.
The state mutation, success audit and readback share one D1 batch and recheck current
administrator authority at commit. Concurrent explicit commands are ordered by
that database commit; a later command may change the state again.

Pausing preserves encrypted credentials, refresh capability, keys, grants, existing
sticky bindings/defaults, allowances and usage. Refresh, import, OAuth completion
and metadata projection cannot clear it. Resume removes only this administrative
block; revoked, expired or reauthorization-required credentials and normal key,
grant and credit checks still govern use. No provider logout or automatic failover
occurs. Other ChatGPT accounts and Grok/xAI are unaffected.

The admission boundary is the selected account metadata read before encrypted-token
resolution for a provider attempt. A read observing `paused` fails with stable
`credential_paused` before dispatch and instructs the caller to contact an
administrator. An attempt already admitted before pause committed may continue,
including a token refresh already in progress. Pause does not cancel admitted
requests, streams, or external jobs. A later request must pass admission again.

Paused accounts are unavailable for new bindings, key replacement, defaults and
retirement replacement targets. Database write guards close the pause-versus-new-
assignment race. Existing defaults and bindings remain visible and unchanged; a
paused default makes new issuance unavailable until the account is resumed or an
administrator explicitly selects another account. The Console shows credential
health separately, identifies affected keys/defaults, and explains these effects
before confirmation. Notifications are best-effort invalidation after commit.

Native SQL and controlled browser checks establish this mechanism, not deployed
behavior. After an authorized deployment, capture bounded metadata readback and
forwarding evidence under the release procedure; additional paid probes need an
explicit budget. Neither pause implementation nor issue creation authorizes a
production account mutation.

## New-key defaults

Administrators configure independent default mappings for Codex, Grok and xAI. Grok and xAI may select the same account but remain independently configurable. A positive xAI allowance plus an xAI key delegates shared team authority; see [surfaces](../product/surfaces.md).

For ordinary `POST /me/keys`, accept a safe name, eligible services and finite expiry. Resolve the current default for each selected surface on the server, validate compatibility/usability, and commit the key/family, complete bindings and success audit together. No internal credential identifier is accepted from or returned to the member. Missing or unusable defaults fail the entire creation, never a subset of its bindings.

The operator seam `POST /admin/users/:userId/keys` supports explicit exact scopes and one `credential_bindings` entry per grant. All issuance follows the [canonical key policy](../product/organization-access.md#5-api-key-lifecycle); the interface cannot bypass expiry, capacity, entitlement or actor checks. Explicit administrative binding choice remains an authorized operation, not a member option.

Default changes are issuance-time only: old keys keep A, future new keys use B. Replacement copies A. Do not implement hidden failover or request-time default routing.

## Explicit rebinding and retirement

Existing exact-key seams are `GET /admin/keys/:id/credential-bindings` and `PUT /admin/keys/:id/credential-bindings/:surface` with a compatible `credential_account_id`. Rebinding changes only the selected key/surface; it must not mutate scopes, other keys/surfaces or provider token material.

Normal retirement with live bindings is **Migrate bindings and disconnect**:

1. Read the exact credential, impacted live bindings and default references; select and validate the compatible replacement.
2. Present the impact and provider-resource continuity limitation for explicit confirmation.
3. Prevent concurrent new assignment to the retiring account. Commit the intended binding/default changes and metadata audit without partial D1 results.
4. Revoke the old encrypted TokenAuthority state, then confirm cleanup. If cleanup fails, leave the old account non-selectable and expose a retry-safe recovery state.

No replacement means normal disconnection is blocked while live bindings exist. That includes `DELETE /admin/codex-auths/:id`, `DELETE /admin/subscriptions/:id`, and dashboard logout. Break-glass is only `POST /admin/codex-auths/:id/force-disconnect` or `POST /admin/subscriptions/:id/force-disconnect` with `ADMIN_SECRET`; it names the affected keys and writes an audit. No silent migration is permitted.

D1 and TokenAuthority do not share a transaction. Implement and test staged failure/retry semantics. Do not claim disconnection is complete because only metadata changed. Migration switches future upstream identity; it does not migrate files, stored responses, jobs, histories or derived secrets held by the provider.

## Replacement and revocation

A replacement copies the source family, name, scopes and sticky bindings under [API-key lifecycle](../product/organization-access.md#5-api-key-lifecycle). Issuance does not change the source lifecycle: a usable old key remains usable until expiry or explicit revocation, and an expired source does not revive. Expiry and capacity limits are defined by that contract, not repeated in this runbook.

Creation shows plaintext once and persists only the prefix/HMAC. A lost response requires metadata reconciliation followed by explicit recovery, not secret retrieval. Rename affects display metadata only. Revocation is permanent and cannot be undone by login or account enable.

Legacy keys keep existing secrets and bindings and may retain null names/expiries. Grandfathering never exempts them from active-user, exact-grant or current allowance checks. Replacement follows the new policy.

## Evidence hygiene

Use secret-free object IDs, safe prefixes, timestamps, stages and result codes for readback. Never put tokens on command-line arguments or into docs, issues, screenshots, logs or generated test fixtures. Review provider-supplied errors before sharing. Follow [security](../../SECURITY.md), [verification](../develop/gates.md), and [release](release.md).
