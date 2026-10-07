# Agency Relay product experience

This page owns console journeys, client-setup outcomes and operation meanings. [Console design](../../design.md) owns presentation, components and UI copy. Identity/key policy belongs to [organization access](organization-access.md), and provider authority to [surfaces](surfaces.md). Use current source and runtime evidence to establish implementation; this page is not a deployment record.

## Promise and vocabulary

Organization members sign in with their verified work email, create and manage their own client keys, and understand their current access and usage. Administrators govern membership, allowances, and the upstream accounts that make those keys usable.

The member journey is **Sign in -> Create a key -> Configure a client -> Complete real work**. The administrator journey is **Prepare organization access -> Connect accounts -> Set defaults -> Govern people -> Recover safely**.

An organization login, a configured key, a positive allowance, a connected upstream account, a configuration download, and a completed client task are separate facts. Never collapse them into one green Ready indicator.

## Sign-in and account identity

Feishu is the only interactive sign-in entry. Agency Relay identifies the user by the verified canonical email, not by Feishu `open_id`. Signed-in identity uses the current server-projected email and role. Do not expose subject IDs or identity-linking controls.

A first eligible login creates an active ordinary user. It creates neither a key nor administrator privileges. A disabled member sees access denied with an administrator recovery path; signing in again cannot reactivate the account.

Different emails are different accounts unless an admin performs **Change email**. That action retains the internal user ID, keys, quota and history, shows the old and new email, rejects collisions and requires confirmation. User-editable email/profile identity is not provided. An existing target account is never silently merged.

**Sign out** ends the browser session and clears sensitive displayed content. It does not revoke client keys. **Revoke all my keys** is a separate explicit action. Ordinary members cannot disable their own Agency Relay account.

## One shell, distinct authority

Member destinations include Home, My keys, My usage, My quota and Setup. Administrator destinations additionally include People, Quotas, Accounts, Requests, Management records and Routes. `/me` retains its personal meaning for administrators; personal and organization actions keep distinct authority and context. [Console design](../../design.md#layout) owns their shared navigation presentation.

The role-neutral `/` entry resolves the current principal on every request. **My space** and **Organization management** are separate areas for administrators. Personal HTML uses `/admin?area=me&view=home|keys|usage|quota|setup`; existing member links remain accepted, and `/me` APIs keep their own-only meaning. Responsive navigation exposes the same authorized destinations; its open state carries no authorization. Accepted navigation updates identity from the current server projection for the same actor.

The server resolves the current principal and selects a role-appropriate page model. Do not render organization data and hide it with CSS. Ordinary HTML, JSON, search results, aggregate counts, setup files and error payloads must not disclose other members or internal upstream account details.

A stable console deep link survives an expired session through an allowlisted return target stored with the one-use login state. Only the opaque state goes to Feishu; callbacks do not select their own destination. The destination checks the newly resolved principal again. Section fragments are carried by the login enhancement; the native no-script flow retains the exact path and query. Unknown or unsafe return URLs are rejected rather than normalized to another object.

On document departure, enhanced pages discard private content, drafts, one-time results and hydrated controls. A restored document offers a fresh, exact GET instead of reusing old authority or replaying a submission. Returning from the background rechecks the current identity and role through `/me`; unchanged authority preserves unfinished work without reload. A failed or changed-authority check clears the old view and offers recovery. A pending write can remain committed on the server even after the page stops waiting.

Deep links always load the exact authorized object. Missing, foreign, expired and unavailable objects never fall back to another person's key or account. All writes enforce ownership/role and the browser-mutation guard server-side.

## Member Home

Home answers: who is signed in, which services are enabled, what needs attention, and what to do next. Show the most relevant recovery action before secondary onboarding.

The compact service table connects used/cap progress, own keys and the exact key and time of the latest observed task result. Time color is accompanied by accessible success/failure text. A known absent result leaves its cell empty; a failed read remains unknown. The delegated-service collection keeps an independent read state, so its failure does not hide known personal data.

Service states must distinguish:

| State | Meaning and next action |
| --- | --- |
| Disabled / unconfigured | Explicitly disabled or no policy exists; contact an administrator. |
| Finite zero | No positive-charge admission or new issuance; already-authorized zero-charge operations may continue. |
| Enabled, remaining credits | Organization permits chargeable work; key/bound-account readiness is still separate. |
| Monthly allowance exhausted | No chargeable admission until the allowance changes or the next UTC month; show reset time. |
| Administrator setup required | Entitlement exists but a default needed for new key creation is not usable. |
| Existing key unavailable | Its stored binding or key lifecycle prevents use; a different current default does not repair it. |
| Unknown/unavailable | A required read failed; never display a fabricated zero or an empty inventory. |

Inventory, quota explanation, new-default metadata and task observations have independent failure states. A default or quota read failure cannot hide already-known keys or their rename/revoke controls. Existing keys use their own stored binding; new defaults affect only new issuance. Per-account metadata is deduplicated without refreshing TokenAuthority or probing providers. Metadata eligibility is not provider health.

Recent successful work is dated and attributed to the exact key and service. Models probes, configuration downloads, and a previous key's task cannot verify a replacement. Readiness snapshots are not continuous monitoring guarantees.

## My keys

The inventory exposes safe key metadata and replacement relationships. An exact-key URL presents that key with an explicit return to its scoped collection; missing selection never substitutes another key. Legacy keys may have no name or expiry; show that truthfully. Name validation, expiry, family capacity and legacy compatibility are defined once in [API-key lifecycle](organization-access.md#5-api-key-lifecycle).

Create (+) and explicit bulk revocation sit in the inventory header. Enhanced management expands the exact row locally, without a navigation read. Collapsing retains the mounted edit draft; an open detail defers background replacement. An unknown write result blocks additional writes until a fresh authorized read. Native exact-key links and forms retain the same server ownership checks and scoped return. Configuration uses a terminal icon and opens the local file task.

Creation asks only for a name, eligible services and expiry under that policy. A member cannot choose or see an upstream account ID. The server resolves current defaults for the selected services.

When issuance is unavailable, show its current eligibility or family-capacity reason in the creation task. Replacement confirmation explains rotation overlap; do not call overlapping secrets one secret. Preserve legacy inventory and show why new issuance is unavailable rather than hiding existing keys.

Creation is all-or-nothing. If one selected surface lacks a usable default, show which service needs administrator setup without disclosing credentials. Do not issue a partial key or silently drop that service.

Show plaintext only in the confirmed successful creation response. A required page-data read failing afterward must not discard this one-time result. Offer a canonical GET recovery address; refreshing must not replay creation. A recognized native submission replay returns metadata only under the [issuance contract](organization-access.md#5-api-key-lifecycle). No old-key reveal, stored setup package, local-storage recovery or analytics capture is allowed.

### Replace safely

**Replace key** creates a fresh secret in the same family with the same name, exact scopes and sticky account bindings. It does not use the latest organization default. The user chooses a fresh expiry under the canonical lifecycle policy.

Show both key prefixes and the actual old-key lifecycle. A currently authenticating source remains usable until expiry or separate revocation; an expired source does not revive when a replacement is issued. Verify the new configuration against the replacement itself, then explicitly revoke the old key. Do not automatically retire the old secret after a download or a guessed timer. Block another replacement while that overlap remains live.

A no-longer-enabled copied surface or unusable copied credential blocks replacement rather than silently changing authority. Explain the available recovery: create a separately eligible key or ask an admin to repair bindings.

Rename and revoke act on the selected key only. Revocation is permanent and separately confirmed; a family and its history remain understandable afterward. A confirmed rename/revoke stays confirmed even if a subsequent list read fails; offer a read-only retry and do not repeat the write. Lost or unrecognized mutation responses are **Result not confirmed**, never an invitation to replay the action automatically.

## My quota and My usage

Quota is read-only for members. Show effective allowance, inherited/custom source, consumed and remaining credits, and reset time for each service. A shared reset may appear once, with per-row dates only when they differ. Used progress measures consumed credits against a finite positive cap; zero, unlimited, disabled and unknown do not produce an invented percentage. An explicit personal zero remains Custom. All of the member's keys share that service allowance; replacement does not refill it. Policy precedence, zero/disabled/exhausted meanings and accounting are owned by [Credit operations](../operate/credits.md).

My usage remains own-only, including for an administrator in the personal area. Use the ranges and measurement semantics in [Usage](../operate/usage.md#daily-trends). Chart axes and inline daily tables carry exact UTC dates and unfinished periods; independent coverage stays beside measured values. Routine read clocks and unobserved media categories do not occupy the page. A failed range switch identifies retained data as stale; an older response cannot replace the latest selection. Detail-row text search does not alter full-range trends or server scope. Do not render team aggregates and filter them in the browser. Control-plane audit remains an administrator page.

## Administrator People and Quotas

People uses canonical email as the visible member identity, with role and active/disabled state. JIT is normal onboarding; manually invented names with optional email are not the new identity model. Administrative provisioning, when used, requires a valid unique organization email and grants no implicit key or administrator role. The server generates the internal ID. Unresolved historical rows remain explicitly non-login and retain their API rights.

The inventory separates Members, Administrators, Service accounts and Pending classification before server search and pagination. Category context replaces repeated role badges in rows; exact details still identify the target's role. People defaults to 20 rows, with explicit 10/20/40 choices retained in navigation. Resizing does not change the current page or size. Add member and Create service account open one inline form beside the inventory toolbar; switching or cancelling retains editable input in the current document. Native links open the same inline task without scripting.

Selecting a member opens a shareable, exact-user detail with keys, allowance overrides and lifecycle controls. Search/pagination must not change the exact selected target. Service-key coverage uses the complete authorized read, independently of the visible key page or search. Account state, key validity and request admission remain separate facts. Counts represent the authorized inventory, not only the visible page. Detail links lead directly to access, keys, service-specific allowance forms, identity/management and account status. Assigned-service facts remain reachable when present or unread. Hide a verified-empty assignment region, but retain the copied-service-key consequence in disable confirmation.

Admins can promote/demote members, disable/enable accounts, change email and manage their keys under the [administrator lifecycle rules](organization-access.md#administrator-lifecycle). Confirmation identifies the target, change and consequences. Email migration preserves identity/history and API keys but expires prior browser sessions; disable/re-enable cannot revive those sessions. Self-demotion ends at the personal area and self-email migration at reauthentication, without rereading a now-forbidden admin page. Native and enhanced forms retain the same confirmed result when a later read fails. An uncertain result requires read-only reconciliation rather than replay.

Organization Quotas shows the affected scope before submission: default changes affect inheriting members, while personal overrides remain independent. **Use organization default** removes an override; it does not grant Unlimited. Keep finite zero, Disabled and exhausted states distinct under [Credit operations](../operate/credits.md#entitlement-remaining-credit-and-changes).

xAI controls must explain that the surface delegates upstream team authority, including shared resource operations and a derived-credential endpoint. A positive xAI organization default would extend that authority to inheriting members. Do not label it private or owner-isolated just because My keys is isolated.

### Service accounts in People

People also shows **Service account** and **Unresolved legacy account** context.
The same exact-account detail owns keys, current allowance and access state;
there is no separate service ledger or duplicate management application. A service
uses its safe display name and a visible stable ID to disambiguate duplicate names.
Search includes the label. Login-email and role-promotion controls are absent
for services, and the server rejects those operations independently.

**Add service account** asks for a label, explains the non-login identity and
Disabled initial policies, then opens the created target. Administrators name,
disable/enable, configure allowance and manage keys through that detail.
Classification is offered only for eligible unresolved non-login rows, names the
exact ID, and explicitly says existing rights and history are preserved. A stale
review stays rejected until the administrator refreshes and reviews current state.
Creation/classification failures preserve editable label input, and native forms
and enhanced forms both show a recoverable outcome. No plaintext key or upstream
secret belongs in service metadata, identity audit or screenshots.

### Assigned service management

Personal Home lists only services explicitly assigned to the signed-in human.
Selecting one opens `/me/service-accounts/:id` with the service name and stable ID
visible, service-scoped navigation and a return to My space. Its keys, quota, usage
and setup use that explicit context. Operations and one-time key results identify
the service; personal `/me` pages do
not merge service keys or usage. Current authorization controls each read and the
committing write, even when a page was opened before transfer or human disable.

Service detail in People lets an administrator assign one current active human,
transfer management or remove the assignment using the reviewed relation revision.
A stale form requires a fresh review. An unavailable current owner is shown as
current context, while the new-owner field requires an explicit eligible human or
removal choice; a missing field cannot delete the assignment. Confirmation states that management access
changes while all existing bearer credentials remain unchanged; the former owner
may still make API calls with copied keys. Safe key names, prefixes, status and
expiry remain reviewable beside a separate link to deliberate revoke/replace.
Cancelling changes nothing; transfer does not automatically disable or rotate.

Human detail also shows a bounded administrator-only offboarding impact view,
with explicit truncation and separate exact-service/key management links. Failed
assignment or key reads are unknown, never an empty inventory. Current assignments
do not establish which other service credentials the person may have copied.
The human-disable confirmation distinguishes personal console/API authentication
from service bearers: services, assignments and copied keys remain unchanged until
a separate deliberate revoke/replace action. Cancellation has no effect.

A disabled service remains visible to its active assigned owner with an explicit
recovery explanation. Creation and replacement are unavailable, while existing
keys can be inspected, renamed or revoked, including revoke-all. Re-enabling is an
administrator action and never revives revoked keys. Native and enhanced forms
retain exact service/key GET recovery locations, metadata-only replay receipts,
private/no-store responses, one-time secrets and read-only reconciliation of
uncertain outcomes.

## Administrator Accounts

Accounts remain ChatGPT and Grok upstream credential accounts, not Agency Relay member accounts. Ordinary members never see this inventory. Search/read models, exact selection, state and pagination remain bounded and truthful. Duplicate labels or IDs across providers do not change selection.

Create an account record, then connect through OAuth. The browser console does not accept uploaded auth/session files or manual provider token values. Restricted operator import remains a recovery function. Opening the inventory must not probe every provider account; opening a selected detail may load its own optional snapshot.

An unfinished OAuth session and callback remain only in the current task response. The retained account inventory, linked-key navigation and other workspace mutations are read-only until completion or explicit cancellation. Cancel, close or page departure ends that page's authorization step; returning requires a fresh start. Do not put callbacks or pending sessions into drafts, GET recovery URLs or cached pages.

Keep **connected**, **expiring soon**, **access expired**, **degraded**, **reconnect required**, **disconnected** and **authorization pending** distinct. Expiry alone does not mean reconnect is needed: the token may be refreshable. A failed optional provider read is unavailable, not disconnected.

A rejected Codex refresh shows its safe failure message and current stored account state in the same response. Recognized expired, reused or invalidated refresh credentials require reconnection; transient refresh failures do not prove revoked authorization. Rendering this failure must not retry the provider operation. Stored connection status is not real-time provider health.

When TokenAuthority commits changed credential metadata, a session-authorized WebSocket invalidates the administrator's connection display. Pages displaying upstream accounts subscribe and reread local metadata; personal pages and other administration tasks do not. Updates change connection badges, expiry/refresh times, recovery hints and refresh eligibility without replacing the selected task or unfinished input, and pause during navigation or submission. Notifications carry no credential details. Reconnect, foreground return and a two-minute poll reconcile missed notifications; read failure retains the last confirmed facts. This reports changes Agency Relay has detected, not unobserved upstream revocation. Session expiry or lost administrator authority ends the channel and requires a fresh authorized read.

For each service, an admin may select a default compatible account. Grok and xAI defaults are separate even if they currently select the same account. The default-change impact must be clear: **Changing this default affects new keys only. Existing keys keep their account. Replacements copy their previous binding.**

A key-detail **Use account** action changes one explicit key/surface binding. It does not change scopes, tokens, another surface, or other keys. Show the intended impact and audit it.

### Retirement and recovery

Account detail includes impacted live key bindings. A normal disconnect with live bindings opens **Migrate bindings and disconnect**, showing the old account, selected compatible replacement, affected count, and any default pointers that need review. Cancel changes nothing. No replacement means normal disconnection is blocked; protected operator force-disconnection is not a routine shortcut.

Migration moves future requests to another upstream identity. It does not copy provider files, conversations, jobs, or other provider-owned resources. Show this limitation before execution.

After submission, report the actual stage: bindings/defaults migrated, old account unavailable for new assignment, and token cleanup confirmed or still requiring recovery. Do not claim one all-or-nothing D1 transaction includes encrypted TokenAuthority state. Unknown results require readback, not a second blind migration.

## Setup and safe verbs

| Verb | Changes | Must not imply |
| --- | --- | --- |
| Create key | New family/secret, eligible scopes and default-derived bindings | A completed client task |
| Replace key | New overlapping secret in the same family; copied bindings | Old key revoked or default account adopted |
| Revoke key | Selected secret permanently unusable | Browser logout or another key revoked |
| Rename key | Display name only | Secret, identity or quota changed |
| Sign out | Browser session/display state | API keys revoked |
| Set allowance | Effective future admission policy | A key scope rewrite, refund or usage reset |
| Use organization default | Remove personal override | Unlimited access |
| Refresh account | Provider token/expiry state | Key rotation or client configuration changed |
| Reconnect account | Renew provider authorization | Member role or key secret changed |
| Migrate bindings and disconnect | Explicit upstream reassignment and retirement | Provider-owned resources copied |
| Sync configuration | Local file made from a key already held | Any server mutation |

Local Setup produces a selected client's configuration from a key the user already holds; generating a file grants no authority. Organization Setup may also select an exact authorized member/key and its task evidence. Personal and delegated-service Setup have no selected-key inventory. Supported artifacts and destinations are:

| Client | Artifact | Destination |
| --- | --- | --- |
| Codex CLI | `codex-config.toml` | `~/.codex/config.toml` |
| Grok Build | `grok-config.toml` | `~/.grok/config.toml` |
| xAI API | `xai-api.env` | Client environment, with explicit base URL |

All client surfaces use Agency Relay bearer keys. xAI clients must explicitly pass `https://xai.trustedtunnel.app/v1`; do not claim arbitrary SDKs automatically read a base-URL environment variable. Caller keys are never forwarded to providers.

A one-time setup package is part of the key creation response. Later local configuration sync requires a key the user already possesses and must not send it back for server storage. Local generation requires scripting; without scripting do not expose an inert secret input. Download, installation, authenticated use, and dated real work remain distinct outcomes.

## Application quality and lifecycle

The same functionality, permissions and meanings apply across responsive layouts. Reflow, rotation and split-screen preserve exact selection and safe in-progress work. Presentation and accessibility rules are maintained in [Console design](../../design.md).

Core task acceptance is unassisted correct completion plus understanding of the result, not merely screenshots or interaction counts. Test normal, empty, long-content, permission-denied, stale, expired-login, unavailable and uncertain-mutation states. Existing quality targets remain p75 LCP <= 2.5s, INP <= 200ms and CLS <= 0.1, with mobile/desktop and lab/field evidence distinguished. These are acceptance targets, not observed results. The bounded [console performance diagnostic](../develop/gates.md#bounded-console-performance-diagnostics) establishes only identified synthetic mobile/desktop loading and interaction conditions. Field p75 LCP, INP and CLS remain unverified without authorized real-user samples and an observation window. Lab interaction timings and blocking diagnostics cannot substitute for field INP. Keep measured findings with the owning issue/PR, and remeasure only changed journeys; obtaining field evidence is a separate bounded task, not permission to add telemetry.

The optional installed app uses the dedicated dashboard host, manifest and icons. Installation adds no authority. The exact manifest, icon and worker paths remain protected by the canonical host and a current active console session for either role; business administration retains its separate role checks. Both signed-in areas declare the credentialed manifest, and its start URL is `/`. Launch opens role-appropriate Home; authorized deep links retain their target. The service worker is network-only for navigation and may show a generic offline retry/Home page. It must not cache sensitive HTML, keys, auth responses or APIs, intercept/queue writes, or force-reload an unfinished task. A manifest alone does not prove physical-device install or OAuth return behavior.

Navigation reads fresh server state without prefetching all management views. Failed navigation preserves the current task and a native recovery link; a superseded response cannot replace the latest destination. Back restores safe scroll/filter context. A missing/foreign selection cannot expose substitute data.

Non-sensitive drafts may survive in-document navigation, refresh and resize, isolated by operation and exact object. Show Unsaved changes/Discard. Never restore secrets, passwords, callbacks, hidden fields, confirmations or one-time packages. A changed server default or unavailable choice requires review rather than silently restoring stale authority. Drafts remain in memory, not local storage, history payloads or page caches; leaving the document clears them.

Only one UI mutation may be pending in a document, while database safety still handles multiple tabs. Confirm success before clearing the matching draft. Stop waiting cancels the browser wait, not the server operation. An unknown result requires fresh-state reconciliation. Native forms remain available without scripting and use the same backend rules.

Eligible visible console pages perform quiet scoped reads every two minutes, or five minutes for Usage. Selected upstream snapshots and creation/write-result pages are not background probes. A changed business model can replace idle content; read clocks alone cannot. Retain current drafts, focus, scroll, filters and open controls, deferring changed data while a task is in use. Show only meaningful pending, deferred-update or failure status; browser refresh is the explicit fresh-read action. Foreground authority recovery remains a separate check. Remove one-time secrets before page restoration. Required read failures are unavailable, never fabricated zero/empty success.

## Reporting and diagnostics

Admin Requests offers one bounded, administrator-only request list with exact internal-audit-ID inspection. UTC date, exact plan/person/result and safe correlation filters remain with the list during inspection and survive refresh or close. Exact detail is independent of the displayed filtered page; closing preserves its filter and cursor context. The filter and list share the same server scope; independent service/person summary inventories do not appear below them. Home failure links preserve the observed plan, failure UTC date and error-result filter. Retained metadata, current labels and unrecorded stages stay distinct; a missing record never proves no request occurred. Read-only recovery links do not retry provider work. See [request diagnosis](../operate/debug-transport.md#retained-request-drilldown) for evidence and disclosure boundaries. Canonical Audit shows control-plane changes and actor roles; these are distinct evidence streams. Usage retains exact service/plan/model or media-capability dimensions and coverage-qualified Provisional Billing, never an invoice or fake cross-provider total. Provider cost is never estimated from tokens or model names.

Routes remains an admin diagnostic view of the exact plan catalog with canonical public path labels, not raw regular expressions. It exposes method, path, service, recorded results and authority facts. Recorded success is not a live availability probe. Local filters describe only rendered rows and never alter backend scope, totals or permissions.

Control Audit shows a bounded recent history and identifies truncation. Current object names and exact links are navigation aids; historical actor email and role remain the audit snapshot. Missing or unsupported objects retain their recorded identifiers without links to substitute targets.

Administrator Setup supports server search and pagination without coupling exact selection to the displayed inventory page; missing and foreign keys never select a substitute. Selected-key configuration and task evidence refer to that exact key while the searchable inventory remains reachable from the top context disclosure. The independent held-key mode does not clear selection or borrow the selected key's permissions or task evidence; one client choice controls its download and destination. A replacement action must disclose that it issues a new key. See [Console design](../../design.md#layout) for page composition and disclosure.

Personal and delegated-service Setup generate local configuration from a key the user already holds. These pages do not read or display key inventories, eligibility, balance, bindings or task evidence. One scoped help control combines installation and recovery. Recent task observations belong to the exact key's detail; workspace result links open that detail. Generating a file grants no authority and does not establish successful client work.

Organization Quotas uses one settings table and one confirmed Save below it. Before submission, explain inheritance, retained personal overrides/use, zero-allowance semantics and positive xAI shared-team authority. The complete set of defaults and its audit records commit together, conditional on current administrator authority and the displayed prior values; a stale or missing default rejects the whole save. Native and enhanced HTML retain the confirmed values even if the following page read fails, with a canonical GET recovery link. Native forms display a POST result: cancel a browser resubmission prompt and follow the read link. There is no Post/Redirect/Get guarantee or automatic replay. Existing per-service JSON contracts remain supported through the same mutation boundary.

Agency Relay does not expand Codex, Grok or provider semantics through console work. Client product features and releases remain external authorities.

## Contextual task help

Key operations retain their confirmation and replacement guidance. Personal and
delegated-service setup combine installation and recovery in one help control.
Configuration destinations are generated by
the same `client-setup` templates as downloads; control props contain file metadata only.
The help distinguishes current server eligibility, saved task evidence and local
file generation; it does not add a help application, new authority or retry path.
Existing configuration must be backed up and selectively merged, not replaced
wholesale. These explanations remain readable without JavaScript or private
repository access; browser-local file generation still requires JavaScript.
