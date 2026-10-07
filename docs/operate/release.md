# Release, organization cutover and rollback

This page owns release operations. The [organization access contract](../product/organization-access.md) is accepted target behavior, not a deployed-state assertion. Do not change live data, secrets or traffic merely because the documentation or implementation issues exist.

Use the current workflow and native CLI help for exact deployment commands; do not invent flags. Record real operation identities and results in the owning release issue/PR rather than a second local release ledger.

## Pre-release

Confirm the intended repository revision and clean working tree. Use [verification](../develop/gates.md): relevant static checks and deterministic tests first; bounded live evidence only where an actual deployment boundary is in scope. Record the current Cloudflare deployment/version before switching traffic.

Documentation-only changes do not require provider probes, a Worker deployment or a D1 migration. A code merge is not a successful rollout.

## Database changes

Use the native Wrangler migration path. List pending migrations against the intended D1 database, apply them in ascending order, then read back the migration list and the affected schema/data invariants. A local schema test does not establish deployed D1 state. Do not run a migration again after an unknown outcome until its authoritative state is reconciled.

Current writers set human/service identity explicitly. Retired compatibility triggers are not a supported rollback path. A rollback target must preserve explicit account kinds, session epochs, RBAC, ownership and fail-closed credit policy. Unresolved accounts require deliberate administrator classification; missing mailboxes do not imply service identity. Database changes must preserve existing keys, bindings, policies and usage unless their change is explicitly authorized.

Keep one-time upgrade proofs only while the upgrade is pending. Once its effects are confirmed, remove copies of retired writers and completed transition tests. Test the current schema and current operations instead. Migration files remain inputs to Wrangler and fresh database construction; they are not a development narrative.

## Acceptance evidence

The owning release issue is the real tracking consumer for prerequisite implementation issues. It must record the deployed revision and the actual results of:

| Boundary | Required result |
| --- | --- |
| New member | Eligible email gets one ordinary account, not admin or an implicit key. |
| Isolation | Member cannot read or mutate another user's data or access any admin route, including deep links. |
| Bootstrap/admin lifecycle | Intended admin works; concurrent last-admin protections and recovery path are proven by owning deterministic tests. |
| Keys/setup | Named expiring key is returned once; replacement retains sticky binding, does not kill the old key, and can be separately revoked. |
| Admission | Unlimited, finite caps, Disabled and inheritance match reads and actual requests, including zero-charge plans. |
| Credentials | New keys use current defaults; old/replacement keys do not silently switch; retirement has confirmed recovery semantics. |
| Offboarding | Disabled Agency Relay user fails subsequent console/API authorization despite a still-valid Feishu login. |
| Database changes | Existing keys, bindings, policy and usage survive unrelated schema changes. |
| Privacy | Ordinary views and logs contain no internal credentials, hashes, other-user metadata or plaintext recovery. |
| Rollback | Chosen rollback cannot restore blanket admin or Unlimited behind the widened policy. |

Keep tests bounded and revoke temporary keys. For the Feishu console, use the deployed redirect, organization mailbox, and session. A mocked token exchange does not prove the live Feishu app. Verify xAI with explicitly delegated temporary authority only where needed; do not probe broad shared-team operations merely to get a green smoke.

## Worker release mechanism

Use one computed Git SHA for artifact identity. Upload a version with message exactly `release $GIT_SHA`, inspect version bindings/secrets-presence/compatibility flags, deploy the intended version to 100% traffic with the same annotation, and read back deployment status.

Full `wrangler deploy` can require access to every routed zone, including the dashboard custom domain. Prefer version upload/deploy for code when appropriate; route changes require an identity authorized for the affected zones. Keep `global_fetch_strictly_public` for the same-zone tunnel path.

Reachability smoke includes Worker and egress `/healthz`, operator `/admin/readiness`, and the affected exact client surface. Models reachability is not a completed task. Changed Responses/transport paths require their owning bounded semantic evidence, not unrelated clients' release state.

## Diagnose before modifying authority

A red smoke blocks acceptance of the affected surface but does not identify its cause. Record the last proven stage: deployed version, Worker health, egress health/accept, Agency Relay authorization/admission, credential readiness, provider status/terminal event and semantic result.

A timeout or missing task result is not evidence that ChatGPT credentials are wrong. Use [transport debug](debug-transport.md) and the smallest next diagnostic gate. Do not repeatedly submit paid operations for a favorable sample. Read-only state/log inspection is not another product operation.

## Codex egress operations

Retain the existing egress deployment contract. Resolve the node, SSH identity,
Tunnel and active artifact directory from the operator's private configuration
and authoritative infrastructure readback. Re-branding the repository does not
move the node or change the configured Worker-facing origin. A hostname is not a
region assertion.

Use release-identified directories, with `current` selecting the active release.
Runtime files are `server.mjs`, `node-transport-adapter.mjs`,
`transport-lifecycle.mjs` and `egress-protocol.json`. Keep the shim and cloudflared
units active/enabled; unit definitions remain under `deploy/codex-egress-shim/`.

The shim listens on `127.0.0.1:8789`; read the Tunnel readiness address from its
service configuration. `.env` and `.tunnel-token` in the service directory are
service-user-only. Worker and shim `CODEX_EGRESS_SECRET` must agree. Use the
operator's configured SSH identity, not a hardcoded private-key path. Egress
changes require `pnpm run egress:test` and release-identified artifacts.

## Rollback

Roll traffic by an explicit prior version ID with a clear annotation. Worker code rollback does not roll back D1 schema, secrets, TokenAuthority state, revoked keys, changed emails, or external provider effects.

Do not put Cloudflare Access back in front of the console, and do not roll back to an Access-equals-admin build. Console recovery stays Feishu login plus the explicit Agency Relay role. A verified mailbox is not an administrator. Prefer a known schema-compatible build that retains email RBAC and fail-closed admission; otherwise restrict access or stop affected traffic until safe recovery is established. Likewise do not silently restore missing-policy Unlimited behavior.

A safety rollback can be correct before root cause is known. Record it as a risk response, not proof of an unverified diagnosis. Never print secrets, pass them on CLI argv, or commit operator `.env`/local `.dev.vars`.
