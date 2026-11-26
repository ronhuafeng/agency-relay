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

The [CI workflow](../../.github/workflows/ci.yml) builds one candidate per checkout:
Console runtime assets, binding types, egress modules and the final Worker bundle.
Its manifest binds file digests to the actual Git SHA and tree. Type, runtime,
design and browser jobs download and verify that same candidate by the upload's
immutable Artifact ID. Attempts have separate artifact names; reruns do not
overwrite earlier evidence or select a package by a mutable name. Browser fixtures
still bundle their Node-only test adapter; they do not regenerate Console assets.
The final Worker bundle also receives a no-bundle local runtime smoke. A PR merge
checkout is not relabeled as the standalone head SHA.

After all required jobs succeed on a push to `main`, the reusable
[release workflow](../../.github/workflows/release.yml) automatically uploads that
same Worker bundle with `--no-bundle`. It does not rebuild or fall back to source.
Release jobs are serialized and reject a superseded main SHA. Candidate artifacts
are retained for 30 days; deployed packages and scalar deployment evidence are
retained as `worker-<SHA>` GitHub Releases. A release archive proves package
retention and deployment readback, not that later health/readiness checks passed;
read the linked Actions result as well.

The workflow reads production before upload and again before cutover. It requires
an identified single-version deployment, no pending or newer D1 migrations, required
secrets, exact variables/DB bindings, stable Durable Object namespaces and runtime
flags. Retained historical migration names are not pending migrations. A
configuration change (in `wrangler.jsonc` or the private production settings), a
migration or an authored egress-shim change stops automatic release. After applying
the migration or deploying the shim, an operator approves the release by running CI on
`main` through `workflow_dispatch` with `approve_config_change`; that run rebuilds,
verifies and releases the same way, still checks the D1 migration ledger, and skips
only the comparisons against the running version. It never applies migrations, changes routes, deploys egress,
rotates credentials or rolls back automatically. The preceding version remains
the code recovery target only while its schema and authority stay compatible.
An unknown upload/deployment result requires readback before another write.

The public Wrangler file is a local build template. Production jobs materialize
an ignored `.wrangler.production.json` from that verified template and the
repository secret `WRANGLER_PRODUCTION_SETTINGS`. Supply a JSON
object with `name` (Worker name), `databaseName`, `databaseId`, `routes` (the
existing Wrangler route array), and `vars` with exactly
`ADMIN_DASHBOARD_HOST`, `CONSOLE_EMAIL_DOMAIN` and `RUNTIME_MCP_ORIGIN`, plus
`codexEgressServiceId`, the production Codex egress VPC Service UUID. The public
template declares no VPC Service because local `wrangler dev` cannot emulate one; the
`CODEX_EGRESS` binding exists only in the production configuration. Include the MCP and console Custom Domains in `routes`.
The MCP origin is HTTPS without a trailing slash. The candidate archive contains
the local template. The production file and Wrangler command output stay on
the release runner. Public results omit production configuration values.

On the initial connector cutover, apply migration `0042` through the native
D1 workflow and verify the existing Stitch installation's resource, revisions
and credential binding. Use the same MCP origin as the existing resource. The
migration reserves existing URLs and preserves those values. The automatic
code-release guard stops on this configuration and migration change, so an
operator must perform the initial cutover. Before allowing path or header
changes, use a recovery version that understands the new configuration.

Apply `0043` before releasing Feishu tool selection. It preserves the configured
URL, credential binding and member access. After a service-level consent release,
existing valid Feishu clients discover enabled tools through their next refresh.
Verify the enabled tool list from the console and confirm
the Stitch URL and authority revision through readback.

Repository Secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` authorize
Worker version upload/deployment and read-only D1 ledger verification;
`MINI_ADMIN_SECRET` is used only for operator readiness. PR jobs receive no release
credentials. `CLOUDFLARE_API_TOKEN` is an account-owned token limited to Workers
Scripts Edit (version upload/deployment and readback), D1 Read (the preflight
`d1_migrations` query) and Connectivity Directory Bind (uploading a version with the
`CODEX_EGRESS` VPC Service binding). Do not widen its authority to bypass a blocked
preflight; creating or editing VPC Services, tunnels, routes or DNS is operator work
with separate credentials.

Use one computed Git SHA for artifact identity. Upload a version with message exactly `release $GIT_SHA`, inspect version bindings/secrets-presence/compatibility flags, deploy the intended version to 100% traffic with the same annotation, and read back deployment status.

Full `wrangler deploy` can require access to every routed zone, including the dashboard custom domain. Prefer version upload/deploy for code when appropriate; route changes require an identity authorized for the affected zones. Release control requires the `global_fetch_strictly_public` runtime flag for provider fetches.

Durable Object class lifecycle changes require `wrangler deploy`; `versions upload`
cannot apply them. This command publishes the version and switches traffic, so
verify its actual Version ID and Deployment ID immediately afterwards. After a
class lifecycle migration, Cloudflare cannot roll back to a version before that
migration. A forward recovery build must retain the new class/binding and current
schema while restoring the required behavior. Do not delete the namespace to
recover code. See [Cloudflare's lifecycle deployment contract](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/#durable-object-class-lifecycle-changes).

Reachability smoke includes Worker `/healthz`, operator `/admin/readiness` with `codex_egress: configured`, and the affected exact client surface. Models reachability is not a completed task. Changed Responses/transport paths require their owning bounded semantic evidence, not unrelated clients' release state.

## Diagnose before modifying authority

A red smoke blocks acceptance of the affected surface but does not identify its cause. Record the last proven stage: deployed version, Worker health, egress health/accept, Agency Relay authorization/admission, credential readiness, provider status/terminal event and semantic result.

A timeout or missing task result is not evidence that ChatGPT credentials are wrong. Use [transport debug](debug-transport.md) and the smallest next diagnostic gate. Do not repeatedly submit paid operations for a favorable sample. Read-only state/log inspection is not another product operation.

## Codex egress operations

The production Codex egress node is accessed through the operator's SSH alias
`egress-sg`. Use that alias for maintenance; resolve its address and SSH identity
from the operator's private configuration, not a hardcoded IP or key path.

The Worker reaches the node only through the `CODEX_EGRESS` Workers VPC Service
([invariant](../develop/responses.md)): an `http` Service on the `egress-sg` tunnel
targeting the shim at `127.0.0.1:8789`. The node has no public Worker-facing hostname.
The connector must stay on cloudflared 2025.7.0 or later with the QUIC protocol and
outbound UDP 7844. Before an update, read back the Tunnel connector, local service
and active artifact directory on `egress-sg`.

Use release-identified directories, with `current` selecting the active release.
Runtime files are `server.mjs`, `node-transport-adapter.mjs`,
`transport-lifecycle.mjs` and `egress-protocol.json`. Keep the shim and cloudflared
units active/enabled; unit definitions remain under `deploy/codex-egress-shim/`.
Read the Tunnel readiness address from its service configuration. `.env` and
`.tunnel-token` in the service directory are service-user-only. Worker and shim
`CODEX_EGRESS_SECRET` must agree. Egress changes require `pnpm run egress:test` and
release-identified artifacts.

For a `cloudflared` security update, follow the [official update guide](https://developers.cloudflare.com/tunnel/guides/update-cloudflared/)
and preserve the installation method: use the same package manager for managed
packages, or the official updater for a standalone binary. Select a release that
includes the required security fixes and verify the downloaded artifact before
restarting `cloudflared-codex.service`. A connector-only update does not require a
shim restart or a Worker deployment. Stopping a connector can interrupt active
SSE requests; do not promise connection continuity from replica count alone.

After restart, verify the running process executable's version, both services'
active/enabled state, Tunnel `/ready`, local shim `/healthz`, and operator readiness.
Health checks prove reachability, not a completed Provider task. Record the exact
release and readback evidence in the maintenance commit or owning issue, not a
separate current-version ledger. Do not silently restore a version excluded by the
security advisory if recovery is needed.

Creating or editing a VPC Service requires Connectivity Directory Admin; attaching
it to a Worker requires Bind, and any account member with Bind can attach it to any
Worker, so `CODEX_EGRESS_SECRET` remains the egress authentication. `wrangler vpc
service update` replaces the whole configuration: read the full Service back after
every write. To replace the Service, create the new one and read it back, set
`codexEgressServiceId` in the private production settings, release with an approved
configuration change, and run a bounded smoke whose transport trace correlates the
Worker outcome with egress acceptance and outcome. Recover with a previous VPC-bound
version or by restoring the Service, tunnel or shim.

### Deploy or roll back the egress shim

A shim release is the four runtime files built from one commit, stored in
`~/codex-egress-shim/releases/<full SHA>/` on `egress-sg`. `current` is a symlink to
the active release, and `codex-egress-shim.service` runs `current/server.mjs`.

1. On a clean checkout of the commit to deploy, run `pnpm install --frozen-lockfile`,
   `pnpm run egress:build` and `pnpm run egress:test`. The build must leave
   `git status` clean, because the committed `.mjs` files are what get deployed.
2. Read back the node: `readlink ~/codex-egress-shim/current` (this is the rollback
   target), both units active, and `curl -s 127.0.0.1:8789/healthz` returning `ok`.
3. Create `releases/<SHA>/` and copy `server.mjs`, `node-transport-adapter.mjs`,
   `transport-lifecycle.mjs` and `egress-protocol.json` into it. Never overwrite an
   existing release directory. Compare `sha256sum` on the node with the checkout.
4. Switch and restart:
   `ln -sfn ~/codex-egress-shim/releases/<SHA> ~/codex-egress-shim/current`, then
   `sudo systemctl restart codex-egress-shim.service`. A restart ends in-flight SSE
   streams, so choose a quiet window.
5. Verify: the unit is active, `/healthz` returns `ok`, `readlink current` names the
   new SHA, and one bounded request shows `egress_request_accepted` and
   `egress_transport_outcome` with `transport_trace_status: ok` in the shim journal.
6. If the change also needs a Worker release, approve it as described above.
7. To roll back, point `current` at the previous release directory, restart, and
   repeat step 5.

When a unit file under `deploy/codex-egress-shim/` changes, install it to
`/etc/systemd/system/` and run `sudo systemctl daemon-reload` before the restart.
Record the deployed SHA and the readback in the owning issue.

## Rollback

Roll traffic by an explicit prior version ID with a clear annotation. Worker code rollback does not roll back D1 schema, secrets, TokenAuthority state, revoked keys, changed emails, or external provider effects.

Do not put Cloudflare Access back in front of the console, and do not roll back to an Access-equals-admin build. Console recovery stays Feishu login plus the explicit Agency Relay role. A verified mailbox is not an administrator. Prefer a known schema-compatible build that retains email RBAC and fail-closed admission; otherwise restrict access or stop affected traffic until safe recovery is established. Likewise do not silently restore missing-policy Unlimited behavior.

A safety rollback can be correct before root cause is known. Record it as a risk response, not proof of an unverified diagnosis. Never print secrets, pass them on CLI argv, or commit operator `.env`/local `.dev.vars`.
