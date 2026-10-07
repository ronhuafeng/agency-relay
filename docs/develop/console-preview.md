# Local console preview

This is the frontend debug and design-review workflow. It runs current Agency Relay pages
against local data so layout, copy, controls and their outcomes can be reviewed
together. [Console design](../../design.md) owns presentation;
[Design System Governance Loop](design-system.md) owns styling architecture and
[Product experience](../product/experience.md) owns action meanings and recovery.

Run `pnpm run console:preview` with Node 26 and the locked dependencies installed.
Open <http://127.0.0.1:4183/__preview>. Set `PREVIEW_PORT` to use another loopback
port. The workbench serves the real router, SSR, generated client and stylesheet.
Changes under `src/` or `tokens/` rebuild those assets; the workbench reports when a refresh is
ready. Refresh is explicit, so it does not silently replace an unfinished task.
Restart after changes to the preview harness, schema or dependencies.

Code refresh and product data refresh are separate. The workbench refresh applies
its selected role, scenario and theme, retains the current object URL, and loads
new generated assets. Eligible product pages also read their local data quietly
at the cadence defined in [Product experience](../product/experience.md#application-quality-and-lifecycle).
An unchanged model keeps its DOM; drafts and open controls defer changed data.

## Frontend debug and review workflow

1. Select administrator/member and the page. Choose populated, new-organization
   or long/paginated synthetic data. Use a private snapshot only when real inventory
   shape is needed; its missing usage and upstream data are not product failures.
2. Follow the actual task through search, exact selection, editing and return.
   Review the composition, wording and control choice against `design.md` and the
   source-ownership rules in `design-system.md`.
   Exercise available empty/error states, confirmation cancellation and confirmed
   outcomes rather than reviewing only an initial screenshot.
3. Check the affected task at narrow/wide widths and light/dark/system themes.
   Use the host platform's system fonts. Fixed widths emulate layout, not a
   physical device, keyboard or installed-app environment.
4. Edit the source, wait for the update notice and refresh. Local actions use real
   SQL and mutation handlers; **Reset example** restores the selected scenario.
   Use **Open standalone** to inspect the current product page outside the
   workbench's iframe. It retains the current selected-object URL and local data.
5. Keep review evidence scoped to role, scenario, page, width and theme. Shared
   screenshots/annotations must use synthetic data and exclude one-time secrets.
   Run the relevant [local preflight](gates.md#design-system-local-preflight-and-ci)
   before commit/push, then review the actual Actions result separately from design
   approval. Unavailable execution is not a passing check.

The workbench and standalone tabs share one local session. Changing role or
scenario, or resetting data, also affects those tabs on their next request.
Preserve needed work before reset. This workflow does not prove production
authentication, deployed provider behavior or completed client work.

## Production metadata as a local scenario

`PREVIEW_ENV_FILE=/absolute/path/to/operator.env pnpm run console:preview:pull`
reads the configured D1 database through Cloudflare's query API. The file must
supply `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN_D1_READ` (or the existing
`CLOUDFLARE_API_TOKEN`). This explicit download performs SELECTs only. The preview
server itself loads no operator environment and has no remote database binding.

Add `--email person@example.com` to download exactly one human account and its
key display metadata, bindings, credit policies and reports. Queries are scoped
in D1, before data is downloaded. Organization defaults and their referenced
upstream display metadata are included as dependencies; owned service accounts
and other people's rows are not included. The download fails without replacing
the snapshot if the email does not resolve to exactly one human account.
Set `PREVIEW_ACCOUNT_EMAIL=person@example.com` when starting the preview to prefer
that person's local session within their actual role. This does not change roles
or grant access to a disabled or non-login account.

For large task histories, explicitly add `--request-limit 5000` (1–5000 allowed)
to import only the newest records, ordered by creation time and ID. The workbench
shows the imported and available record counts. Daily usage and credit counters
remain complete; filtering older task history can only search the imported rows.

The allowlists in `scripts/console-preview/snapshot.ts` include people, provider
account display metadata, key metadata, bindings, quota policies, service owners,
credit consumption, daily usage and request display metadata.
They exclude key hashes/prefixes, sessions, provider identifiers, tokens,
traffic and request bodies. A bounded query fails rather than silently truncates.
The local importer substitutes invalid key material and creates local-only
sessions with the existing role rules. Names, emails and internal object IDs are
still private data; this is not an anonymized public fixture.

The private snapshot is stored with owner-only permissions at
`tmp/console-preview/snapshot.json`, which Git ignores. It is never a test or CI
artifact. Select **Production snapshot / local copy** in the workbench. All edits
change the in-memory local database; resetting reloads the snapshot. A new download
replaces the snapshot file only after every selected table is read successfully.

Both download modes include credit consumption, daily usage aggregates and
request display metadata. Old snapshots without reports remain importable;
their missing history says nothing about production usage. Measurement coverage is retained;
request/session/thread/response correlation identifiers are excluded. The preview
only offers roles with a real active login-capable account in the snapshot.
Neither mode imports upstream credentials or proves provider availability.
External provider requests fail locally. Use synthetic scenarios for publishable screenshots;
never capture one-time keys or private snapshot rows into shared test artifacts.

## Rendering and interaction boundaries

The Node adapter maps the loopback origin to the canonical fixture origin and
injects a local session server-side. It retains the application's same-origin
write checks. Only the local adapter permits same-origin framing and forces the
selected theme for both color-scheme media queries and native controls. It does
not register a service worker.
No production CSP, cookie policy, routes or deployment configuration is changed.

The [preview implementation](../../scripts/console-preview/) owns toolbar controls,
scenario data and adapter behavior. Add a scenario there only when an affected task
cannot be reviewed with the existing data; do not create another rendering path or
copy product policy into the harness. A rendered preview remains a design candidate,
not visual approval.
