# Organization access contract

## Status and authority

This is the contract for the email-first organization console. Open GitHub Issues own remaining work. This page is not a second issue tracker or a release history.

[Experience](experience.md) owns user interaction, [surfaces](surfaces.md) owns provider authority, [credits](../operate/credits.md) owns credit operations, [credentials](../operate/credentials.md) owns upstream operations, and [release](../operate/release.md) owns cutover. The requirements below describe semantics; implementation issues select the narrowest mechanisms that prove them.

## 1. Scope

V1 has one organization and two application roles, `admin` and `user`. The dashboard host admits a person through one Feishu custom app. Agency Relay accepts only a verified mailbox whose domain is `CONSOLE_EMAIL_DOMAIN`, then stores an 8-hour host-only session. Do not create a password, a second login provider, or a multi-tenant model.

The browser leaves the dashboard only for the Feishu authorization page and returns to `/login/callback`. Do not keep Cloudflare Access in front of that host. Client hosts continue using Agency Relay bearer API keys. Do not add browser redirects to API client surfaces. `ADMIN_SECRET` remains a separate operator identity, not a browser login.

## 2. Email-first identity

Exchange the Feishu authorization code on the server, then read the mailbox from the user-info response. Prefer `enterprise_email` when its domain matches; otherwise use `email`. Missing, malformed, expired, or non-organization identity fails closed. An unsigned email header, request body, query parameter, cookie forged without a server session, or service token cannot identify a console user. Feishu `open_id` is not an account key. Do not store the Feishu access token or refresh token.

Normalize the trusted email with `trim().toLowerCase()`. This is the organization's application identity policy, not a universal claim about every email system. Do not strip plus tags, remove dots, merge aliases, infer a person from a name, or use `sub` to match an account. Email-domain matching must respect domain boundaries; a similar suffix is not an authorized domain.

Each active, email-login-capable user has a unique canonical email. Keep a stable internal `user.id` for keys, credit policies, reporting, and audit. `sub` is not a required user column, not an authorization input, and not a relinking key. A changed `sub` with the same verified email does not create a new Agency Relay user.

### JIT behavior

| Canonical email lookup | Result |
| --- | --- |
| No existing account | Create one active `user`; never create an admin or an API key implicitly. |
| Existing active account | Resolve the same `user.id`; use current D1 role/status. |
| Existing disabled account | Deny console access; never reactivate through login. |
| Conflicting or incomplete identity | Refuse matching and require administrator identity review. |

Concurrent first logins must resolve to one account. Use a database uniqueness constraint and an atomic insert/conflict/read path; a Worker-local lookup is not sufficient.

### Email changes and reuse

A different verified email is a different login identity by default. An admin may explicitly change an account's email to preserve its internal ID, role, keys, allowances, usage, and history. The operation must validate the canonical target, reject another account's existing target email, recheck actor authority, and audit the old/new identity metadata. The target must belong to the configured organization domain. Never silently overwrite or merge an already-created target account. Administrative human creation also requires that domain and generates the internal ID on the server; protected operator creation of historical/non-login records remains a separate interface.

Email migration is a reauthentication boundary. The mailbox update, console-session epoch change, and success audit commit together. Previously issued browser sessions and in-flight login snapshots from an older epoch cannot authenticate the renamed account. Session creation validates the captured mailbox and epoch at its INSERT; verification joins the session with the current user in one snapshot. Disable also advances that epoch, and re-enable never restores an older browser session. Role changes are read from the current user, not frozen into a session.

Browser reauthentication is not API-key revocation; a compromised or copied bearer needs a separate explicit revoke or replacement. Changing a mailbox or session epoch does not change key hashes, bindings, quotas, usage, or stable user IDs.

After a change, a request carrying the old email must not resolve the renamed account. Because JIT is enabled, an otherwise still-authorized old email can become a separate ordinary account; it must not inherit the renamed account's rights or history. Directory alias retirement and old-address admission are operator responsibilities.

Email reuse is an explicit trust assumption: a verified email alone cannot distinguish successive people assigned that address. Offboard the previous holder in Agency Relay before the address is reassigned; do not auto-enable a disabled row for its new holder. Reuse, restoration, or ownership transfer requires an administrator's review. This design intentionally does not solve reuse by introducing `sub` identity.

### Unresolved identity

An account with missing, invalid or ambiguous mailbox identity cannot sign in. An administrator must review the exact account before linking an organization mailbox or classifying a service. Preserve internal IDs, foreign keys, usage and secrets. Do not fabricate mailboxes, auto-merge people, or grant admin because an email appeared in an operator log. Active console users must satisfy the canonical identity contract.

### Service accounts and unresolved legacy owners

`users.id` remains the ownership and metering identity for humans, services and
unresolved legacy rows. `account_kind` distinguishes `human`, `service` and
`legacy_unresolved`; missing email alone never classifies an account as a service.
All supported writers store account kind explicitly. The database does not infer
human identity through compatibility triggers. Unresolved accounts retain their
API keys, policies and usage until an administrator reviews their identity.
Historical/non-login `POST /admin/users` creation is protected operator-only;
browser admins use explicit human or service creation instead. The existing outer
host/route allowlist returns 404 for browser-host `POST /admin/users`; this change
does not introduce or remove a browser version of that operator endpoint.

Services have a trimmed, safe 1–64-character display label. Labels may repeat and
are not login identities; management always targets the stable account ID.
Services have no email/canonical mailbox, `login_capable = 0` and ordinary `user`
role. They cannot acquire Feishu/JIT/session access, human lifecycle privileges,
or administrator authority, and never count toward last-human-admin protection.
`/me` continues to represent the signed-in human personally.

New service creation commits identity, three explicit **Disabled** credit mode
rows and canonical success audit together. No observer can see a fresh service
inheriting a positive default between those writes. Disabled is not finite zero.
Subsequent administrators may use the existing credit operations to grant finite
or Unlimited policy or restore inheritance; the same keys, families, bindings
and usage ledgers apply, with no service-specific accounting system.

The operator can inspect one exact ID with `GET /admin/users/:id` to obtain its
kind, mailbox/login status, role, display label and review timestamp; the existing
credit read supplies its policies. The response includes no keys, hashes, binding
credentials or session material. Browser admins inspect the same account in People.

Classification is a separate explicit operation on a reviewed unresolved,
non-login ordinary row with no mailbox identity. It verifies the review timestamp
and source identity/status/epoch at commit. Human accounts and already-classified
services are not conversion candidates. A stale review or concurrent human
remediation rejects without partial state or a success audit. Classification
changes only kind, label, identity epoch and update time; it preserves exact API
material, families, expiry, grants, active status, sticky bindings, finite and
Unlimited policies, consumption and history. It never initializes Disabled policy.

Admins and the protected operator may create, inspect, rename, explicitly
classify, disable and enable services. Disabling affects subsequent data-plane
authentication; it does not cancel established upstream work. Enabling restores
only otherwise-valid keys and never revives revoked keys or old sessions. Current
human-admin authority is checked inside service and credit mutation commits;
browser writes also use the shared Origin guard. Actor/target metadata lives in
`operator_mutation_audit`. Ownerless services remain administrator-managed.

### Explicit service delegation

Each service has one optional human-owner relation, with a monotonic revision for
administrator assignment, transfer and removal. New services start unassigned;
creation never assigns its creator.
Only a current active, organization-login-capable human may be assigned; services
cannot own services. Administrator authority is independent of this relation.
An owner mutation requires an explicit active-human choice or explicit removal;
an absent or unsuccessful form field never means removal. A currently disabled
owner remains assigned until an administrator deliberately changes the relation.
The audit's prior-owner snapshot must match the submitted revision, which is also
checked at commit; guessing a later revision cannot attribute a transfer to a
stale prior owner.

`/me/service-accounts/:id` is an explicit service context for safe metadata, keys,
quota, usage and setup. Personal `/me` continues to select the signed-in human.
Owners reuse the canonical name, expiry, five-family capacity, bounded replacement
overlap and complete usable sticky-binding rules. The service's stable ID owns all
keys, families, scopes, bindings, allowances, consumption and history; the human's
personal capacity and allowance are unchanged. Owners cannot select upstream IDs,
change service identity/status, quota/defaults, assignment or organization audit.
Foreign, unassigned and missing service IDs produce equivalent denial.

Each key write checks the current active human, mailbox, session epoch, service
kind and owner relation or current admin role inside its committing SQL. A
transfer/removal, human disable or authority change that commits first prevents
the later delegated write and its success audit. An active human's admin demotion
retains an explicit owner assignment. Service disable blocks issuance, replacement
and subsequent API authentication; an active owner can still inspect safe data,
rename keys and explicitly revoke one or all keys. Only administrators re-enable
the service, and revoked keys stay revoked.

Human disable or delegation removal does not disable the service. Transfer changes
control-plane management only: a former owner may have copied bearer secrets, which
remain usable until their ordinary expiry or separate explicit revocation. Show
safe affected-key metadata and offer deliberate revoke/replace operations. Never
claim transfer recalls a bearer or silently rotate keys, reset consumption, move
provider resources or alter bindings. Assignment changes and key mutations have
separate canonical audit events naming the human actor and service/key target;
failed writes cannot leave partial effects or false success audit.

## 3. Principal, roles, and object ownership

A human principal contains the resolved internal user ID, canonical email, current role, and active status. Read current authorization at the operation boundary; do not preserve administrator privileges solely in an 8-hour browser token or stale UI state.

`/me` always means the current principal, including when that principal is an admin. `/admin` is organization-wide management. All list, search, count, aggregate, export, setup, and mutation paths obey the same scope as their parent resource.

| Capability | User | Admin |
| --- | --- | --- |
| Read own profile, usage, allowance and setup | Own only | Own through `/me` |
| Create/list/rename/replace/revoke API keys | Own, plus explicitly assigned service contexts | Own, plus explicit cross-user administration |
| Manage members, roles, status and email changes | No | Organization-wide |
| Change defaults or personal allowances | No | Organization-wide |
| Inspect/change upstream credentials and bindings | No | Organization-wide |
| Read canonical control-plane audit | No | Organization-wide |
| Logout from browser session | Yes | Yes |
| Self-disable account | No | Lifecycle action with admin safeguards only |

Self-service handlers derive ownership from the principal, never from a caller-supplied `user_id`. A foreign or nonexistent key has the same `404` response. No actor can use a data-plane API key to call console administration. Hiding a menu is not authorization.

### Administrator lifecycle

Admins may promote and demote members, including themselves when another active admin remains. Prevent removal, disabling, or demotion of the last active, organization-login-capable admin under concurrent operations, not only in preflight UI checks.

Bootstrap uses `ADMIN_SECRET`: the intended administrator first logs in as an ordinary JIT user, then an operator promotes that exact account. Do not use a first-visitor-wins rule or a permanent bootstrap-email environment override. Recovery remains available to the protected operator identity and is audited.

### Disable and logout

V1 offboarding is manual: remove the person from the Feishu app's available range and disable the Agency Relay account. Agency Relay checks account status for console requests and API-key authentication. The guarantee is rejection of subsequent authorization/admission checks; it does not retroactively cancel a provider request or an already-established opaque WebSocket.

Disabling is distinct from permanent key revocation. Preserve records and usage. Permanently revoke old keys during offboarding when reuse must remain impossible after an intentional re-enable. Revoked keys never revive through login, role changes, or account restoration.

Users may revoke their own keys and sign out, but cannot self-deactivate. Signing out ends the browser session; it does not revoke client keys. Future SCIM/directory integration may invoke the same lifecycle operations but is outside V1.

## 4. Allowance and entitlement

The effective monthly allowance for a user and surface is:

```text
personal override ?? organization default ?? 0
```

A personal policy is explicit Unlimited, a finite cap, or disabled. It overrides the organization default. Removing a personal override means inherit, never Unlimited. A missing final policy fails closed. Defaults live in D1 and are administrator-managed. Initial Codex, Grok and xAI defaults are all zero; an operator explicitly configures access before enabling the new runtime.

A positive effective allowance grants issuance entitlement for that surface. Explicit Disabled denies the surface; finite zero permits only otherwise-authorized zero-charge operations and grants no issuance entitlement. A positive allowance with no remaining credits is exhausted, not a removal of entitlement. All keys and families owned by the same user share one UTC-month surface allowance. Creating, replacing, or revoking a key never resets consumption.

Every request still needs a valid key, active user, matching exact key grant, a supported plan, usable bound credentials, and admission. An explicit Disabled mode denies the surface. A finite zero cap denies positive-charge admission but still permits otherwise-authorized zero-charge operations; it is not issuance entitlement. Raising the cap can restore positive-charge use without rewriting scopes. Issuing or replacing a key requires positive current entitlement for every requested/copied surface. Reject rather than silently omit disallowed scopes.

Entitlement checks apply even when a plan's `creditCharge` is zero. A free catalog, poll, file, or control operation is not an exception to disabled-surface authorization. With a positive but exhausted allowance, a zero-charge supported operation may remain usable. Chargeable requests use atomic admission; database failure is not Unlimited.

Credits are Agency Relay admission units, not tokens, dollars, settlement, provider balance, rate limits, or a hard provider-cost budget. Existing plan charges and metering semantics remain owned by the proxy contract. See [credit operations](../operate/credits.md).

## 5. API-key lifecycle

New user-created, admin-created, and replacement keys require a name and a finite expiry. Names are trimmed, 1–64 characters, reject control characters, and need not be unique. Owners may rename their keys; admins may do so explicitly. The internal key ID and prefix remain the identifiers.

Default validity is 90 days; maximum validity is 365 days from issuance. A replacement receives a newly selected expiry under that policy, not the predecessor's old expiry. Persist the key prefix and keyed hash only; return plaintext once in the successful creation response. Never offer reveal, plaintext recovery, or stored setup packages.

Users have at most five live logical key families. Rotation overlap belongs to the same family rather than consuming a sixth slot. A family has at most two live secrets during replacement overlap; finish or cancel that overlap before starting another. This bounds the overlap described by the design instead of creating an unlimited-secret loophole. Revoked/expired history does not consume a live slot. Database conditions enforce family and overlap limits under concurrency. Issuance counts a server-built snapshot using the same instant parser as authentication, then its conditional INSERT revalidates the complete active-row set (identity, family and raw expiry) in both directions. A changed snapshot rejects the write; name and last-used changes do not invalidate capacity. This preserves accepted expiry representations without a second date parser, schema backfill or data-plane lookup.

### Replacement

1. Create a fresh secret in the same family, copying the name, exact scopes, and stored sticky bindings, subject to current issuance rules.
2. Keep the previous key usable until its existing expiry or explicit revocation.
3. Show the new secret once; verify the new client configuration against that exact new key.
4. Revoke the old key explicitly. Do not infer completion from a download or an older key's successful request.

An unrevoked but expired source may conditionally receive a new secret under current issuance/family/binding policy; this does not revive the source. The additive `lifecycle` projection preserves raw `status`, expiry and owner facts, and `old_key_remains_active` is true only when the source satisfies the current key-authentication conditions. Stored ISO expiry representations remain compatible. Both personal and operator replacement responses compute the old-key fact from this lifecycle. Replacement requires a complete current sticky binding for every copied grant at the committing SQL boundary: shared production ChatGPT metadata must be active; production Grok metadata may be active or degraded. Reauthorization-required, pending, retired, missing or incompatible metadata blocks issuance with `replacement_bindings_unavailable` and without a new key, bindings or success audit. This is a denial result, not an issued key; consumers must keep the existing source and read current state before retrying. An elapsed provider-token expiry alone is not a rejection, because refreshability is a separate fact; replacement does not probe tokens or providers.

Replacing a key must not silently switch its upstream to today's organization default. A disabled copied surface or unusable copied credential blocks the replacement atomically; an owner may instead create a separate eligible key, and an administrator can repair bindings.

Repeated submissions must not create accidental duplicate logical keys or unbounded replacements. A lost creation response has an uncertain result: read metadata to reconcile, then revoke/replace the unusable result explicitly. Do not persist plaintext just to make a retry return it. Native UI must not automatically replay mutations. Member issue/replace forms carry a non-secret submission identity scoped to the current actor. The key primary key prevents duplicate creation, while the atomic success audit binds a fingerprint of the actor, exact operation/target and submitted parameters. A matching replay returns only a known-completed metadata link, never plaintext; a reused identity with different content is rejected. Current session authority is still required, and key changes recheck the console actor’s captured mailbox/session epoch and current active login-capable identity at commit. Ownership permits personal operations independently of admin role; changing another owner’s keys requires current administrator authority. Protected operator authorization remains separate. A missing receipt is not proof of success.

### Existing key metadata

Keep existing secrets, IDs, hashes, scopes, bindings and legitimate historical data. An existing key may retain a null name or no expiry. Show its safe prefix and missing metadata rather than inventing a name or mass-revoking it. If an owner already exceeds five live families, preserve those keys but disallow additional families until below the cap; bounded replacement of an existing family remains possible.

Grandfathering applies to key metadata/expiry, not to account status, new entitlement enforcement, or authorization bypasses. All newly issued or replacement secrets obey modern rules.

Supported key writers explicitly store a nonempty `family_id`; replacement keeps the source family. External, operator or rollback tools that omit it are unsupported. Existing-key authentication and forwarding do not require a compatibility insert trigger.

## 6. Default and sticky credentials

An administrator configures one default physical credential per surface. Codex selects a compatible ChatGPT production account. Grok and xAI each independently select a compatible Grok production account; their default values may be equal. No official xAI API-key slot is introduced.

A self-service request contains name, requested surfaces and expiry, not internal account IDs. The server reads a consistent default selection, validates every selected account's compatibility and usability, and commits key, all bindings, family state and success audit together. Missing/incompatible/unusable defaults fail the entire creation with a recoverable unavailable state; no partial key is returned. Compatibility alone is not readiness, and an expired-but-refreshable token is not automatically a disconnected account.

Once created, each key/surface uses its stored binding. Changing an organization default affects future new keys only. There is no runtime default lookup, automatic failover, load balancing, or silent migration of old keys. Rotation copies the old bindings.

Retirement is explicit: show impacted live bindings, choose a compatible replacement, migrate the intended bindings, then disconnect the old account. A normal disconnect with live bindings and no replacement is blocked. A protected break-glass operation may force disconnection with explicit impact and audit.

A credential being retired cannot simultaneously receive new bindings. Address default pointers as part of retirement so they do not silently point at a disconnected account. Bulk migration must respect provider-owned resource identity: an object created under account A is not promised to be usable through account B. Surface that operational consequence rather than claiming transparent resource migration.

D1 metadata/binding transactions cannot atomically include TokenAuthority storage. Use an explicit, retry-safe staged operation: prevent further selection, commit validated binding/default changes with audit, then revoke external encrypted state. Report partial completion and recovery accurately; never report successful disconnection while cleanup is unconfirmed. Do not reopen old authority merely because a retry failed.

## 7. Browser and transport safety

Apply one browser-mutation guard before all console-session writes, including JSON POST/PUT/PATCH/DELETE and native `/me/ui/*` and `/admin/ui/*` POST forms. Require an exact canonical Origin match and reject cross-site Fetch Metadata. Reject missing/invalid origin for this browser-only write surface. Console session verification and server-side authorization are still required. Checking only a subset of forms is insufficient; readable confirmation text is not CSRF protection.

The operator bearer API is a separate non-cookie interface. Do not make `ADMIN_SECRET` a dashboard fallback. Keep the canonical dashboard host and validate the console session at the Worker boundary; an alternate Worker URL must not bypass the console guard.

Runtime consent, revocation, and account rebind are console-session writes and use this same guard. Public OAuth discovery, client registration, and token exchange stay outside it. A public path under `/oauth/` gains no exemption from the guard.

Console responses and one-time secret responses are private and non-cacheable. No service-worker cache, local storage, history payload, analytics event, log, or background retry may retain credentials or privileged HTML. Full logout/deauthorization clears sensitive visible state; subsequent server requests always recheck authorization.

## 8. Audit and consistency

Extend the existing canonical `operator_mutation_audit` rather than building a parallel ledger. Record stable actor user ID, role snapshot, canonical email, actor kind, action, target, result, request correlation, and allowlisted non-secret change metadata. Operator identity remains distinct from a console user. Never store bearer values, key hashes, plaintext keys, callback codes, provider payloads, or secrets in audit metadata.

D1-owned success mutations and success audit should commit together. Rename acknowledges the name UPDATE result independently of concurrent last-used touches. Revoke distinguishes a newly committed change from an already-revoked key; the latter adds no false change-success audit. A failed conditional write must not leave a success audit or dependent rows; zero affected rows are a rejected mutation, not a SQL exception that automatically rolls back other valid statements. Validate the actual D1 behavior with conditional writes/constraints and tests. Do not use a global Worker variable as a concurrency lock.

Role changes, last-admin protection, JIT uniqueness, family limits, entitlement admission, key plus binding creation, and credential migration must remain true under concurrent clients. Unknown database state fails closed. Provider usage observation remains separately non-interfering and must not be made blocking by control-plane audit work.

## 9. Target HTTP surface

These are target interfaces, not a claim that the baseline exposes them:

| Interface | Required scope |
| --- | --- |
| `GET /me` | Current active principal only |
| `GET /me/keys`, `POST /me/keys` | Current user's metadata/issuance policy |
| `PATCH /me/keys/:keyId`, `DELETE /me/keys/:keyId` | Own name update or permanent revoke |
| `POST /me/keys/:keyId/replace` | Own bounded family replacement |
| `GET /me/credits`, `GET /me/usage` | Own effective policy/reporting only |
| API-host `GET /admin/users/:id` | Protected operator only; exact-ID allowlisted identity and classification review timestamp; browser admins inspect People |
| API-host `/admin/services` creation and `/admin/services/:id` inspection; `/:id/name`, `/:id/classify` mutations | Protected operator; browser admins use `/admin/ui/services` forms; exact target; no human-to-service conversion |
| `/admin/users/*` role/status/email/keys | Current active admin; exact target; last-admin safeguards |
| `/admin/*` organization defaults, credentials, bindings, usage and audit | Current active admin |
| Native `/me/ui/*`, `/admin/ui/*` actions | Same services, ownership and browser-mutation guard |
| API-host `/admin/*` bearer operations | Protected operator bootstrap/recovery; never a console-session bypass |

Return only allowlisted public fields. In particular, self-service responses and setup must not disclose credential-account metadata, key hashes, or other users' counts, names, usage or credentials. Keep `/me` scope invariant for admins too.

## 10. Release boundary

Deployments preserve the current email principal, explicit account kind, session epoch, JIT, RBAC, ownership, key lifecycle and fail-closed admission boundaries. A verified mailbox never grants administrator authority. Apply required database changes through the native migration path and verify their effects before enabling dependent code.

Rollback must not restore old blanket administrator authority, silently restore Unlimited, or assume schema/secrets/TokenAuthority rolled back with Worker code. The operator-owned release issue records readiness, migration review, bounded acceptance evidence and the chosen security-preserving rollback. See [release.md](../operate/release.md).
