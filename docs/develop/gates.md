# Verification ladder

This file owns how Agency Relay verifies its own behavior. Use the smallest native/static/live proof that crosses the changed Agency Relay-owned boundary. A design document or test count is not evidence of production behavior.

## Native authority

Use TypeScript, Vitest and Wrangler for Worker code; the owning native egress checker/tests for the shim; and the actual deployment plus bounded live tests for deployed behavior. Current commands are declared in [package.json](../../package.json).

Select relevant commands; do not run every expensive or paid gate merely because a file changed. Do not add wrappers whose purpose is only to dispatch, parse or aggregate other native runners. Documentation headings, Markdown wording and file inventories must not become executable product acceptance inputs.

## Design-system local preflight and CI

The [Design System Governance Loop](design-system.md) owns style-system boundaries.
`pnpm run console:check` validates the DTCG resolver, generates the runtime theme
and `design.md` frontmatter, and fails when those outputs are stale. `pnpm run lint:css`
rejects hex colors, redeclared generated tokens, unknown token references, and
raw or unproven visual aliases, while preserving owned structural geometry.
`pnpm run lint:classes` rejects arbitrary Tailwind values and
visual `style` properties on console TSX, including the primitives. Measured sidebar
widths and the progress transform remain runtime geometry.

For an implemented boundary, run its native checks locally before commit/push and
run the same pinned configuration as direct steps in the existing CI workflow. Keep
the design checks limited to:

- DTCG validation/generation;
- DESIGN.md generation/lint;
- generated-artifact freshness;
- Stylelint;
- ESLint/Tailwind style policy.

Use existing TypeScript, Vitest and Playwright only when the changed behavior needs
them. Do not copy the browser matrix into these checks, create a second workflow
for them, or add a runner whose only job is to aggregate native tools.

A selected failure, missing input/tool/result, cancellation, timeout or unresolved
selection is not success. An irrelevant change may produce a truthful terminal
non-selection result. Do not use retries, `continue-on-error`, `|| true` or automatic
baseline updates to manufacture green results.

GitHub Actions is the final CI signal for the actual revision. Maintainers must
not merge when applicable selected CI is failed, missing or unresolved. Branch
protection may enforce this signal; it is not a separate correctness proof.

Passing design checks establishes the covered deterministic contracts, not visual
approval.

Local/task verification and repository admission have different scopes. During
implementation, select the smallest native evidence that can falsify the changed
boundary. For repository admission, every pull request targeting `main` and every
push to `main` runs all mandatory CI contract groups plus the full Chromium and
WebKit console-browser suites. A hard prerequisite failure may block dependent
evidence; that is a blocked candidate, not a pass and not a reason for a manual
one-off substitute. Repair or update the candidate and let the normal workflow run
again.


## Layers and selection

| Layer | Owns | Does not prove |
| --- | --- | --- |
| L0: source/static | Types, bindings, syntax and artifact validity | Correct runtime authorization or a production policy |
| L1: deterministic contracts | Agency Relay behavior through its owning interface and SQL-backed invariants | Actual IdP/Access deployment or provider capability |
| L2: deployed reachability | Worker/edge/egress and affected endpoint reachability | A completed user task |
| L3: Agency Relay user outcome | Bounded real user-visible Agency Relay flow under `tests/live/` | External client product correctness |
| L4: release acceptance | Deployed artifact, migration/cutover and rollback evidence | Another repository's release/CI status |

Documentation/issue metadata needs no product correctness gate: inspect consistency, scope and external-write readback. Changed Worker behavior needs owning static checks and focused Vitest contracts. Auth, schema, quota, keys and ownership require focused SQL/integration evidence. Egress changes require its native tests. Real provider/edge behavior needs bounded L2/L3 only when that changed boundary actually depends on it. L4 is owned by [release.md](../operate/release.md).

## Organization contract acceptance

[Organization access](../product/organization-access.md) owns the accepted contract. Each implementation issue owns its own relevant tests; do not defer all correctness to a final catch-all testing ticket.

| Contract | Minimum deterministic evidence |
| --- | --- |
| Trusted identity | Feishu code exchange, organization mailbox, tenant present, session expiry; missing/invalid human email; untrusted email-header/body/cookie spoofing rejected. |
| Email/JIT | Canonical case/whitespace policy; no alias/sub merging; concurrent first login produces one account; disabled never auto-enables. |
| Email migration | Stable user ID/history; target collision rejects without merge; old email cannot resolve renamed account; legacy null/collision remediation is explicit. |
| RBAC | Every old/new admin HTML/JSON/setup/read/mutation path rejects a normal member; current role/status rechecked; API key cannot authenticate administration. |
| Ownership | Foreign and absent `/me` object IDs produce equivalent denial; queries, counts, summaries, pagination and exports stay scoped; admin `/me` stays personal. |
| Administrator lifecycle | No first-visitor admin; bootstrap targets exact account; concurrent demotions/disables cannot remove all active admins. |
| Browser writes | Shared exact-origin/Fetch Metadata guard covers native forms and JSON POST/PUT/PATCH/DELETE; missing/foreign Origin rejects before mutation; bearer operator boundary remains separate. |
| Quota | Explicit Unlimited, finite cap, and disabled are distinct. Personal policy overrides the organization default. Missing final policy fails closed. Finite zero still admits a zero charge. Exhausted finite caps, shared family usage, no usage reset, UTC rollover, and database failure stay exact. |
| Atomic admission | Competing last-credit requests cannot exceed the effective cap; no rejected request reaches provider dispatch. |
| Key lifecycle | Name validation, finite default/max expiry, one-time secret, live-family capacity, bounded same-family overlap, explicit revoke, legacy over-limit preservation and modern replacement. |
| Issuance | Every selected surface entitled and every binding compatible/usable; consistent default snapshot; no partial key/family/bindings/success audit. |
| Sticky selection | Default change affects new keys only; old keys and replacements retain binding unless explicitly migrated. |
| Retirement | Concurrent new binding cannot target retiring account; impacted bindings/defaults migrate as intended; no-replacement normal disconnect blocks; token-cleanup failure/retry is truthful and safe. |
| Audit/privacy | Stable actor ID/role/email snapshot; denied writes leave no false success; allowlisted metadata only; no hashes, plaintext, provider secrets or other-user page data. |
| Reporting/setup | Own-only data and artifacts; coverage/unknown preserved; replacement verification attributed to the replacement, not an older key. |
| Migration | Existing IDs, keys/hashes/bindings/usage preserved; no synthetic email/usage; staged activation and rollback cannot restore privilege leaks. |

These are semantic outcomes, not prescribed internal file names or a matrix of implementation call counts.

## SQL and concurrency proof

Use the existing SQLite/D1-backed seams under `tests/support/` and `tests/schema/` for database behavior. Add a bounded actual Worker/D1 proof only when a runtime difference remains material. Do not treat a stub recording `batch()` as proof of a transaction.

An application `SELECT -> await -> INSERT` can race. Conditions/constraints in the committing operation must preserve uniqueness, family count, last-admin existence and quota. Test competing requests and rejected writes. A conditional statement changing zero rows is not necessarily a SQL exception: verify dependent statements and success audit cannot commit a false/partial operation.

D1 and TokenAuthority are distinct stores. Test the retirement sequence with failures before metadata commit, after reassignment and during encrypted-token cleanup. Retry must not duplicate effects, revive retired authority or report unconfirmed cleanup as done. Readback verifies external effect, not a second provider task.

## Frontend debug and design review

Use the [local preview workflow](console-preview.md#frontend-debug-and-review-workflow)
to review the real console before selecting automated checks. It owns startup,
scenario selection, source refresh, reset, standalone review and private snapshots.
Review presentation against [Console design](../../design.md) and source ownership
against the [design-system architecture](design-system.md). Changes to action
meaning also use [Product experience](../product/experience.md). A preview or a
passing browser suite does not establish design approval.

## Browser and human evidence

Rendering tests prove data projection and route guards, not human usability or a deployed Access policy. Add real-browser evidence where interaction, origin/cookie behavior, navigation, one-time secret handling and session expiry are the changed boundary. Use controlled identities and synthetic secrets; never a production credential in a fixture.

Relevant user journeys include eligible first login, own-key creation, setup, replacement/revoke, disabled-member rejection, admin member/quota management and account retirement recovery. Test role-appropriate UI without shipping hidden privileged payloads. Physical-device installation/OAuth-return evidence is required only for claims about those platform behaviors; a manifest alone is insufficient.

The release operator must verify the Feishu redirect URL, organization mailbox domain, and 8-hour console session. A mocked token exchange cannot prove the live Feishu app. Do not use live provider operations to test a locally decidable CSRF or role rule.

## Proxy contract preservation

Exact plan selection, header/credential isolation, native identity projection, opaque forwarding, client-driven streaming, cancellation, resource ownership and coverage-qualified accounting remain owned by their current test seams. Organization work must not smuggle in new routes, body conversion, retry/failover, provider catalogs or unrelated client lifecycle tests.

Provider observation stays non-interfering. Control-plane transactional audit must not make the downstream observer block/replace a successful response. Keep free-plan authorization and charged-plan admission distinct from provider billing.

## Evidence interpretation

Keep three levels separate: mechanism confirmed by source/deterministic tests; current trigger observed from a supported client/provider/runtime; and user impact observed crossing Agency Relay. Historical rationale deserves investigation but cannot override the accepted authority contract or a reproducible local correctness defect.

A bounded probe not observing a behavior is negative evidence for that experiment only. A timeout proves the desired result was not established in its window, not which component failed. Counts, timings, order and intermediate trajectories are diagnostics unless an owned contract guarantees them.

Bound the experiment, not the implementation. Do not repeatedly mutate/retry a product to seek a green sample. Preserve valid historical transport constraints and prefer one owning regression seam over duplicated proof stacks.

## Artifacts, writes and stop rules

Reuse an already-built artifact when its identity and inputs are unchanged. For an authorized external write, distinguish pre-write correctness proof from post-write effect readback. Confirm each issue/PR/deployment identity; reconcile unknown creation results before retrying.

Stop when the owning uncertainty is resolved. A failure can belong to implementation, fixture/probe, environment or external authority; classify the last proven boundary before changing credentials or product behavior. External clients own their own source, Stories, CI and releases.

## Local console browser regression

Run `pnpm run console:check`, then `pnpm run test:browser --project=chromium`;
use `--project=webkit` for the second engine. Install the lockfile browser with
`pnpm exec playwright install --with-deps chromium webkit`. The fixture needs
Node 26 (`node:sqlite`), OpenSSL and loopback sockets. Use a task-specific
`PLAYWRIGHT_BROWSERS_PATH` when installing a separate runtime so cleanup cannot
remove another task's browsers.

Local layout and reachability checks use platform system fonts. Missing Linux
reference fonts must not block those checks. The [browser workflow](../../.github/workflows/console-browser.yml)
uses its explicit Linux reference environment and `MINI_BROWSER_REFERENCE_FONTS=1`;
[visual tests](../../tests/browser/visual.spec.ts) check those font inputs.
Do not replace checksums to hide an environment change. The declared CSS stack
does not prove which font resolved every glyph.

### Fixture and test ownership

[Playwright configuration](../../playwright.config.ts) owns engines and runner
settings; [tests/browser](../../tests/browser/) owns scenarios, widths, themes
and interaction assertions. Add the smallest regression to the owning feature
instead of maintaining another scenario inventory here. A selected failure must
be fixed or attributed to its actual blocker, not skipped into a success claim.

The fixture bundles the production Worker route and SSR in production React mode
and serves generated client/CSS with unchanged product headers. Each test has a
fresh migrated SQLite database, synthetic identities and an ephemeral HTTPS
origin. The loopback-only CONNECT proxy retains the canonical origin, host-only
cookie and native form headers. A fixture-only foreign same-site origin proves
write rejection with the cookie present.

Missing/forged header probes use a separate cookie-free API context: Playwright
can record failure headers even when the exception is caught. External browser
destinations and provider fetches fail closed. The fixture loads no operator
environment, real IdP account or provider credential. Session creation is a
fixture API, never a production/test-login route. This proves Agency Relay routes through
SQLite and a Node transport adapter, not deployed D1, Feishu, edge policy or
Durable Objects.

Await the visible confirmed write outcome before reading database effects;
retaining an object ID is not completion. Departure/Back tests await the exact
destination through document load and its visible target before going Back.
A click may finish at navigation commit while the destination runtime is still
loading. Interrupted reads and pending-write history scenarios need their own
outcome assertions.

CSS magnification and emulated viewports prove only those layout conditions,
not browser-chrome zoom, a soft keyboard or a physical device. Target geometry
is bounded interaction evidence, not blanket accessibility conformance.

### History re-entry and retained lessons

[Page restoration](../../tests/browser/page-restoration.spec.ts) performs real
Back navigation on the unchanged protected document after authority changes.
Both possible branches must prevent former private/one-time content and mutation
replay, then establish a fresh exact-target read under current authority.
A persisted `pageshow` must retain the original document marker and expose only
scrubbed GET recovery. A fresh document must discard that marker and perform its
top-level GET. Record the actual branch after the terminal response; fresh-document
success and synthetic lifecycle events do not establish BFCache restoration.

Keep these earlier failure boundaries because rerunning the current suite cannot
recover their original conditions:

- The pinned WebKit base [excludes HTTPS no-store documents](https://github.com/WebKit/WebKit/blob/4d05d732e5a84f32675bef4cc135a2e7a9269a87/Source/WebCore/history/BackForwardCache.cpp).
  The pinned Chromium [manifest loader](https://github.com/chromium/chromium/blob/153.0.8010.12/third_party/blink/renderer/modules/manifest/manifest_fetcher.cc)
  uses the [loader that records no-store responses](https://github.com/chromium/chromium/blob/153.0.8010.12/third_party/blink/renderer/core/loader/threadable_loader.cc)
  as a BFCache exclusion. Agency Relay's credentialed manifest stays no-store.
- Original strict-restoration failures remain negative evidence for cached
  restoration; they are not passing runs under the history-re-entry contract.
- The earlier full-Chromium experiment did not restore the protected document
  and failed the fixture's external-network assertion. It is not a passing
  standard-engine run. Chromium headless-shell alone proves no BFCache support.

Use the normal lockfile engines. Do not weaken headers, allow external requests,
change TLS trust or remove browser defaults to obtain a cached result. The
self-signed HTTPS fixture does not establish worker registration: its certificate
is rejected for that operation. Protected resource credentials and localhost
worker behavior are separate proofs, neither of which establishes Feishu return
or operating-system installation.

### Worker outage proof boundaries

[Native worker tests](../../tests/browser/shell-installation.spec.ts) run unchanged
production worker source in the browser's localhost secure context. Both engines
must render its 503 response when the origin actually stops and retry the exact
URL when it restarts. Chromium additionally tests browser offline emulation.

Playwright 1.63 WebKit offline emulation can reject worker navigation even for a
literal worker response ([upstream #42775](https://github.com/microsoft/playwright/issues/42775)).
Only that unsupported emulator probe is explicitly skipped. The retained failing
main run is not product success evidence. Origin shutdown proves server
unavailability, not device-wide offline mode or protected HTTPS installation;
no certificate exception or trust change is introduced.

### CI admission and safe evidence

The [browser workflow](../../.github/workflows/console-browser.yml) is full
repository-admission evidence: every pull request targeting `main` and every push
to `main` runs the complete console suite in both Chromium and WebKit. It does
not use changed-path selection or a partial-engine shortcut. Local development may
still run only the engine and scenario needed for the current task.

[Runner configuration](../../playwright.config.ts) keeps automatic retries off.
Intentional reruns retain separate native attempts and cannot turn a failed
candidate into success.

Native local reports stay in ignored `tmp/browser-report` and
`tmp/browser-results`. Trace, video and automatic screenshots are disabled.
`PLAYWRIGHT_NO_COPY_PROMPT` suppresses teardown DOM snapshots, but locator
assertion failures can still include context. Check secret presence/removal with
booleans or counts; never compare/log its value or assert on a locator that may
contain it. A synthetic fixture is not a general redaction guarantee.

Only the workflow's allowlisted read-only display captures and scalar provenance
may be uploaded. They use invalid key placeholders and reject populated one-time
results or held-key inputs before capture. Private preview snapshots are never
CI fixtures or shared evidence. Record actual checkout/tree, role, scene,
viewport, theme, engine and typography environment; a declared font stack is not
a resolved-glyph inventory.

Report PR/base/head, actual checkout, run attempt and suite outcome separately.
A merge checkout is not a standalone head build, and a capture is not a passing
test. Use the workflow's bounded repository-restricted artifact; never upload raw
HTML reports, failure DOM, traces, video, storage state or network bodies.
Base comparisons use the same native display suite only with compatible fixture,
configuration, build and dependency inputs. State incompatibility or base failure
instead of substituting an old image. Do not update pixel baselines automatically
or freeze a rejected design as a golden image.

## Bounded console performance diagnostics

This is an optional investigation, outside normal frontend development and default
correctness selection. [Native configuration](../../playwright.performance.config.ts)
and [measurement source](../../tests/performance/console.spec.ts) own its scenes,
profiles, font requirements, samples and metric definitions. Read them only for
a performance task; check that measured actions still match the current UI.

`NODE_ENV=production pnpm exec playwright test --config=playwright.performance.config.ts`
runs the diagnostic after generated-asset checks, on an identified clean checkout
without competing browser/build jobs. Only its allowlisted numeric
`tmp/console-performance/**/scalars.json` output is shareable; never upload the
whole output directory. Preserve failures and compare named revisions under the
same fixture/toolchain. An unsupported or outdated probe establishes no result.

Local timings and attribution are not field INP, edge/D1 latency or a provider
result. Field targets in [Product experience](../product/experience.md#application-quality-and-lifecycle)
remain unverified without authorized samples and an observation window; this
diagnostic gives no permission to add analytics. Findings belong to the owning
issue/PR, not a permanent experiment log in this document.
