---
version: alpha
name: Agency Relay Console
description: Cyan pixel workspaces with cool light surfaces, deep indigo dark surfaces and crisp task boundaries.
colors:
  primary: "#00dbe9"
  on-primary: "#002a2f"
  background: "#eaedf2"
  surface: "#ffffff"
  on-surface: "#0f172a"
  muted: "#526174"
  border: "#182131"
  input-border: "#526174"
  secondary: "#f1f5f9"
  accent: "#d9f6f8"
  success: "#15803d"
  warning: "#995c00"
  error: "#b4233e"
  on-error: "#ffffff"
  dark-primary: "#00dbe9"
  dark-on-primary: "#002a2f"
  dark-background: "#0f0b21"
  dark-surface: "#1c182f"
  dark-on-surface: "#f0edf8"
  dark-muted: "#b9b4cd"
  dark-border: "#5e566f"
  dark-input-border: "#867d9c"
  dark-secondary: "#28233c"
  dark-accent: "#103c48"
  dark-success: "#68e6a0"
  dark-warning: "#ffd078"
  dark-error: "#ff9bb0"
  dark-on-error: "#3b0b17"
typography:
  page-title:
    fontFamily: 'system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
    fontSize: 20px
    fontWeight: 750
    lineHeight: 1.25
  section-title:
    fontFamily: 'system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
    fontSize: 16px
    fontWeight: 650
    lineHeight: 1.4
  body:
    fontFamily: 'system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: 'system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.5
  caption:
    fontFamily: 'system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
  input-phone:
    fontFamily: 'system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  technical:
    fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace'
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  none: 0px
  control: 2px
  container: 2px
spacing:
  micro: 4px
  related: 8px
  compact: 12px
  content: 16px
  section: 20px
  page: 24px
  wide: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    height: 44px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    height: 44px
  button-destructive:
    backgroundColor: "{colors.error}"
    textColor: "{colors.on-error}"
    rounded: "{rounded.control}"
    height: 44px
  task-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.container}"
    padding: 16px
  selected-row:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-surface}"
  account-menu:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.container}"
    width: 280px
  caption:
    textColor: "{colors.muted}"
    typography: "{typography.caption}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  badge-success:
    textColor: "{colors.success}"
  badge-warning:
    textColor: "{colors.warning}"
  button-primary-dark:
    backgroundColor: "{colors.dark-primary}"
    textColor: "{colors.dark-on-primary}"
    rounded: "{rounded.control}"
    height: 44px
  button-secondary-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-on-surface}"
    rounded: "{rounded.control}"
    height: 44px
  button-destructive-dark:
    backgroundColor: "{colors.dark-error}"
    textColor: "{colors.dark-on-error}"
    rounded: "{rounded.control}"
    height: 44px
  page-dark:
    backgroundColor: "{colors.dark-background}"
    textColor: "{colors.dark-on-surface}"
  badge-dark:
    backgroundColor: "{colors.dark-secondary}"
    textColor: "{colors.dark-muted}"
  badge-success-dark:
    textColor: "{colors.dark-success}"
  badge-warning-dark:
    textColor: "{colors.dark-warning}"
  selected-row-dark:
    backgroundColor: "{colors.dark-accent}"
    textColor: "{colors.dark-on-surface}"
  divider-dark:
    backgroundColor: "{colors.dark-border}"
    height: 1px
---

# Agency Relay design

## Overview

The repository path `design.md` is the console's agent-facing contract for visual
language, page composition, component selection, UI copy and accessible
presentation. The [Design System Governance Loop](docs/develop/design-system.md)
owns token authority, runtime generation and style ownership. [Product
experience](docs/product/experience.md) owns user journeys, operation meanings and
recovery. [Organization access](docs/product/organization-access.md),
[surfaces](docs/product/surfaces.md) and [security](SECURITY.md) retain their
authority. Design cannot create a permission, change a mutation or declare missing
data valid.

Agency Relay is a working console for members and administrators. It should help a person
identify the current object, assess its facts and take the next action without
reading a report first. Related facts and controls form one workspace. Content
density comes from useful comparison and grouping, not smaller text.

Use cyan for actions and selection, a cool-gray canvas with white task surfaces in
light mode, and deep indigo surfaces in dark mode. Navigation keeps the surface
color. Do not repaint the page to match the navigation, and do not wrap the page
in a nested frame. Keep readable system Chinese
fonts, 2px corners, crisp ink boundaries and hard offset shadows. Pixel character
appears in edges, icons, sliding switches, selected states and press feedback. It
does not require low-resolution Chinese text or game decoration.

New screens are designed from Agency Relay's actual read models and API operations.
Generated counts, controls, roles, code examples and success claims are not product facts.

### Authority and review

Pixel character, both color themes, task-based organization, shadcn interaction
patterns, suitable controls and concise copy are user requirements. Agency Relay owns local
styling; upstream defaults are not a second theme authority. Primitive appearance
is owned by `src/admin/ui/components/primitives.css`. Component classes keep structure, state and interaction.
Page CSS may own unique task geometry; it does not restate primitive color, radius
or shadow. Page and workflow
boundaries can be redesigned within existing backend capabilities. The page
compositions below describe the current local design candidate and remain subject
to visual review. Refine a composition when review shows a better task flow; keep
the business contract intact.

Exact reusable values in the frontmatter are generated from
`tokens/console.resolver.json`. Change the shared palette, typography, spacing,
radius, shadows and control decisions there, then run `pnpm run console:build`.
The Markdown body remains reviewed guidance. Component and page geometry that is
still owned outside the shared theme is separate from this generated contract.
`design.md` is the only repository file path; “DESIGN.md” refers to the external
format/specification, not a second file.

Numeric component heights are minimum targets; content may grow. Current
implementation choices are not a ban on better controls. Do not use document
headings or token inventories as executable product acceptance tests.

The format follows the [Google design.md specification](https://github.com/google-labs-code/design.md/blob/main/docs/spec.md).


## Colors

Use the page background as the canvas. A task object, such as a record card or a
form, uses the surface color and one boundary. A page, and a section that only
groups those objects, has no extra frame. Use the foreground for names and facts; muted text is secondary, not a
substitute for a missing label. Input borders are stronger than section dividers.
Cyan identifies the primary action and current selection. The darker teal focus
outline stays visible against white; dark mode uses a light cyan outline. Action
color is not an availability signal.

The `dark-*` tokens replace the corresponding light roles under the system color
scheme. They preserve the same meanings. Do not infer a dark value by dimming a
light color. Runtime CSS uses the generated token names.

Success, warning and error colors must accompany a readable state or icon with an
accessible name. A valid key, enabled member, usable upstream account and successful
task are separate facts with separate labels. Do not merge them into one green
indicator. Selected rows use the accent background and a 3px cyan leading edge;
secondary metadata and state labels remain legible inside the selection.

## Typography

Use `system-ui` first so each platform selects its native UI typeface. Keep
PingFang SC, Microsoft YaHei, Noto Sans CJK SC and `sans-serif` as local fallbacks;
do not require a downloaded font or select fonts through user-agent detection.
Font metrics and glyphs may differ across platforms. Layouts must still preserve
readable text, wrapping and reachable controls. Use monospace for paths,
filenames and short identifiers. Prefer tabular numerals for metrics and times.
Do not turn an internal UUID into the largest item in a row when a useful identity
exists. Legacy objects without a human identity need a truthful label and a
secondary stable identifier.

A visible 20px title names a creation or consequential task; narrow screens use 18px.
Inventory and report pages retain an accessible heading without repeating the navigation label.
Section titles are usually 14–16px; exact object titles use 18px. Large numbers are reserved for a useful
metric, such as remaining allowance. Body text is 14px, with 12–13px metadata.
Phone inputs use at least 16px. Long names wrap; full timestamps and identifiers
remain available when shortened for scanning. Local review uses the current
platform's fonts. Reference screenshots are compared only within a matching
platform, browser and font environment; Linux CI's pinned font inputs do not
become a product font-installation requirement.

## Layout

### Shared shell

Use one shell with a compact brand, navigation and account-menu trigger. Email,
current role appear in the sidebar footer trigger; the menu contains full identity and sign-out. The trigger remains identifiable
and keyboard reachable. Organization and personal areas retain visible context. An administrator switches between them from the account menu, not from a separate navigation row.
The desktop shell uses a compact fixed rail, with its brand at the top and account
menu at the bottom. Its accepted exact width belongs to the canonical component
token, not a second number in this prose. There is no separate reserved header. Narrow organization screens keep the same links in a capsule centered on the navigation line. When that line cannot also show the brand name, only the mark remains. The capsule opens downward into tight clusters, one for each task domain. Each choice is a fixed icon tile with its short label, and the gaps stay constant. Clusters wrap to the width instead of stretching into an empty bar. The tile keeps the console pixel shape. The wide rail stays a vertical rail. Personal screens show five short task links
in one horizontal row, with the complete accessible names retained.

Narrow screens place the brand and account menu in one compact navigation line. There is no global refresh
button, page-name breadcrumb, selected-object echo or routine update timestamp.
Browser refresh provides an explicit fresh read. A compact transient status may show a pending
operation, unavailable update or deferred new data only while that state is useful.
Place page actions beside their inventory, chart or exact task. Keep the page's
accessible heading; a visible heading must add task meaning.

Create, grant and configuration tasks show their task title. Ordinary tasks open
with their collection and object context retained. A named close control ends the
local task; it is not a page Back button. Native close links read the same scoped
collection, retaining search and pagination. Keep submit and cancel in one action
group; closing and explicitly discarding a safe draft have different meanings.
OAuth callback tasks have a separate departure rule: the retained inventory is
read-only while authorization is pending, and cancel/close requires a fresh start.
Callbacks and pending sessions never enter the draft mechanism.

Organization navigation follows the task domains: Workspace contains Organization
overview, Members and services, and Client configuration; Resources contains
Upstream connections and Allowance policies; Observation contains Request records
and Usage reports; Advanced contains Service routes and Management records. My
space remains a separate personal context. Navigation labels do not change stable
URLs or API contracts. There is no organization switcher or global search unless
the backend provides that capability.

### Density and scroll

Use 4px for small alignment adjustments, 8–12px within a related group, 16px inside
ordinary task regions and 20–24px between tasks. These are reference steps, not a
requirement to separate every field. Keep row identity, state and action together.
Compact inventories use roughly 60–64px rows when the content fits. Short content
must not create a tall empty card.

Use available width for comparison or the next task. Do not stretch a few lines
across a blank canvas or add count cards solely to fill it. A region deserves a
border when it groups a task; do not frame each field or nest decorative cards.

The document is the primary vertical scroll area. A wide comparison table may own
a labeled, focusable horizontal region. Menus and help popovers may scroll within
the viewport. Ordinary list/detail panes must not create competing vertical scroll
areas. Never hide document overflow to conceal a broken layout.

### Current page compositions

| Page | Primary organization |
| --- | --- |
| Organization overview | One concise resource strip, the Usage page's responsive daily trends for 7 or 30 UTC days, actionable problems with exact recovery targets and actual upstream connection rows. A failed usage read leaves known resource and connection facts visible. Do not repeat task outcomes in another card. |
| Members and services | Server search and Member/Admin/Service/Pending category links precede a compact table, without repeated row role badges. Inline creation opens beneath one row of toolbar actions. Stable pagination offers 10/20/40 rows, defaulting to 20; resizing retains page and size. The retained collection and selected person's continuous workspace compare side by side when space permits. Identity, state, keys, credits and service ownership remain reachable during key creation or inspection. Exact-key controls expand below their row, or separately when that exact key is outside the displayed page; missing keys never select a substitute. Independent unavailable facts stay unknown. A service table compares key coverage, cap, used progress, remaining and request admission; expand only the policy being edited. Key creation stages the new key's scopes. Identity changes open on demand. |
| Upstream accounts | Provider-qualified account rows remain with creation and exact connection tasks. One continuous inspector holds identity, lifecycle actions, actual disconnection blockers and linked keys. Account name, provider and connection state align horizontally. Manual OAuth opens externally and completes inside the retained task. A separate service/default table below the workspace identifies the connection used for new keys; existing bindings stay unchanged. Unread upstream datasets use compact rows; they do not become empty metric cards or imply a disconnected account. |
| Client configuration | A compact top disclosure retains server search and pagination for exact account/key selection. One configuration workbench below it uses client tabs for the destination, public placeholder template and local download. Held-key local generation is the initial mode. Exact selection adds explicit replacement and held-key modes without clearing selection; only the selected-key mode shows that key's dated task evidence and authorized clients. Templates expand with the document, without an inner vertical scroll region. Replacement remains a separately confirmed consequential action. Personal and delegated-service configuration reuse the workbench with held-key generation only. |
| Request activity | One date/service/result filter and one request table use the same server scope and remain visible during exact inspection. Member and request-ID fields use an explicit precision-filter expansion; populated conditions remain open. Requests remain flat table rows with separate UTC time, person, service, path, result, upstream status and latency columns. Narrow collections keep a labelled, keyboard-scrollable table instead of changing rows into cards; the page itself stays within its viewport. Exact-request detail leads with service/path, current labels and recorded reason. Closing preserves filters and cursor; exact detail need not belong to the displayed page. Internal identifiers stay in field help. Scope help stays at the far right of the filter action row. |
| Usage | The navigation already names the report, so the page heading stays available without being drawn again. One query bar uses the body text size for search. The export is only an icon at that text size, centered on the text line, with no larger button box. The 7/30-day control sits on the legend row, aligned to the end, at that same text size and height; it does not stretch into its own row. A coarse pointer may raise the search to 16px so the browser does not zoom. The export icon stays at the text size. The bar is not a card. Focusing the search hides the export and expands the field in that same row; an empty blur restores it. One grouped bar chart shows recorded tokens, or media starts when that is the only series. There is no chart title, metric caption, metric switch, stacked layout, date picker, selected-day repeat, pricing explanation or expandable data table. The legend uses the same body size as those controls. Axis labels stay caption-sized. Do not show a per-record note about unrecorded tokens. The axis labels use only their own width. Each day has one small trapezoid relief on the axis. Unrecorded values do not show a question mark. Wide detail is one table without a service column: the model name distinguishes Codex from Grok. Narrow detail is one card: model and person on the left, recorded tokens as the primary number, request count and amount quiet, and a failure only when it is not zero, in the error color. There is no per-record detail popover. Exact dates stay on chart axes. An empty range still shows the chart axes and the 7/30 control, without a date line or a second range action. Do not render unobserved media panels or repeat read time. |
| Routes | Service tabs select one hostname and method/path/recorded-result table, with exact native hash links retained. Phone rows keep the result and diagnostic action beside each route; secondary authority and recorded times remain on demand. |
| Management records | An aligned operation/object, historical actor, time and result table that stacks on phones; secondary recorded identifiers on demand. |
| Organization allowance | One settings table compares monthly defaults, with one Save below the table at the right. Accessible service-specific field labels do not repeat visibly. Rules sit in table-header help; the shared-team badge and repeated title are absent. One pre-save confirmation names effects on inheriting accounts, retained use and xAI shared-team authority. |
| My workspace | One service table connects monthly used/cap progress, active own keys with terminal configuration icons, and the exact key and time of the latest observed task result. The result links to that key's detail; time color and accessible outcome text distinguish success and failure. Known absence leaves an empty result cell; a failed read stays unknown. Delegated services retain their own collection entry and independent read state. |
| My allowance | One service table compares monthly cap, used progress and remaining credits. Units are in the headings; policy and reset explanations are in one header help control. Finite zero, exhausted balance, unlimited, disabled and unavailable remain distinct. |
| My keys | One table keeps the entire known inventory, including historical keys. Its header holds Create (+) and explicitly labelled bulk revocation. Management expands safe details and recent task evidence directly below the exact row; native links retain exact-key destinations. Collapse preserves editable drafts. Configuration opens the local file task with a terminal icon. Rename and replacement open on demand inside the detail; revocation remains separately confirmed. Open rows defer background refresh, and an unconfirmed write result blocks further writes until a fresh read. |
| My client setup | The same configuration workbench uses client tabs and a held key for both local download and displayed destination. Public templates expand on demand. It has no key inventory, replacement action or task evidence. Installation and recovery share one help control inside the card. |

On narrow containers, stack the retained collection and task in reading order.
Selection focuses the task; close restores the collection's safe context when
available. Breakpoints respond to usable container width and text
magnification, not a presumed device. Reflow must preserve selection and safe
in-document drafts. Native document departure has the separate privacy lifecycle
defined in the product contract.

## Elevation & Depth

Use a calm 1px boundary for an object that is itself a task. Do not add another frame around the page or around a section that only groups those objects. Internal
rows use a softer 1px divider. Primary and destructive buttons, use a 2px boundary and a
`2px 2px 0` ink shadow; dark mode uses a near-black shadow. Pressed buttons move by 2px and lose
the shadow. Secondary buttons have a 1px outline and no offset shadow. The page
heading has no enclosing frame. Menus and popovers use a `4px 4px 0` shadow. These hard edges preserve
the theme; do not replace them with blurred elevation, glow or glass effects.

Keyboard focus uses a clear teal or cyan outline. Hover cannot be the only way to discover
an action or state. Respect reduced motion; feedback does not require animation.

## Shapes

Controls, cards, badges, menus and avatars use the same 2px corner language.
Switch tracks need a distinct sliding thumb but keep the square visual family.
Icons use the shared line-icon set with consistent size and stroke. Familiar
actions such as refresh need familiar symbols, not custom logos. Text and
accessible names explain consequential actions.

## Components

Use [shadcn/ui](https://ui.shadcn.com/docs/components) for component anatomy,
semantics and interaction patterns. The source-owned primitives in
[`src/admin/ui/components`](src/admin/ui/components) are Agency Relay code and use Radix
behavior where appropriate. Apply Agency Relay's semantic tokens rather than upstream
default styling, and selectively adopt upstream interaction/accessibility fixes.

Compose the existing primitives directly. Extract a shared Agency Relay composition only
after real tasks demonstrate repeated layout or interaction. Pages bind actual data
and operations; they do not redefine primitive internals or semantic tokens. SSR
and native form/popover fallbacks preserve the same actions before enhancement.

Styling ownership and runtime-geometry exceptions follow the
[Design System Governance Loop](docs/develop/design-system.md).

### Choose by user intent

| Intent | Control and treatment |
| --- | --- |
| Go to another page, category or exact object | Native link with truthful URL and `aria-current`; do not make a server query into a local tab. |
| Compare many objects on the same dimensions | Table with real headers, or aligned rows that stack on narrow screens. |
| Change a reversible binary account state | Slide switch with stable accessible label. Ask for confirmation when the existing action requires it; change the thumb only after confirmed server state. |
| Show identity kind, role or a read-only state | Short label or badge. A service account is a kind; administrator is a role. Do not imply they are interchangeable. |
| Select several allowed services | Labeled checkboxes for member creation, or service switches that stage a new administrator-issued key. Neither edits an existing key's scopes. |
| Choose one small finite option | Labeled native select or radio group. |
| Find an exact member/key in a bounded inventory | Searchable picker with server search, pagination and exact target links; name what is being selected. |
| Switch local views of the same selected object | Tabs; only show tabs when there is a real choice. Arrow-key behavior and focus follow the primitive. |
| Submit a task | Text button beside the input or affected object. Use primary emphasis for that task's main action. |
| Confirm a consequential change | Alert dialog with target, effect, explicit cancel and action label; retain the native form confirmation path. |
| Edit an account's existing quota policy | Compare policy facts in a table, with a confirmed request-admission switch and edit icon. Keep the per-row editor and drafts mounted while collapsed; native rendering exposes the complete form. Enabling opens a policy choice rather than inventing a cap. |
| Compare a chart with daily ledger values | On-demand chart text and focusable bars, with a UTC day selector for comparison. Keep the person/model detail table directly after the chart; native rendering retains the data explanation. |
| Read secondary help or diagnostic facts | Labeled popover with title, close control, bounded size and keyboard access. Main task facts remain visible. |
| Access account identity and sign-out | Compact avatar/menu trigger with a dropdown; use the current server-projected identity. |
| No objects or no matching search results | Empty state that names the condition and offers the relevant next step. Failed reads are errors, not empty states. |

Buttons perform actions; links navigate. A key lifecycle badge must not become a
switch merely because it says active. An editable account state and a computed
eligibility fact are different. Native and enhanced paths must preserve the same
meaning. Main configuration, installation paths and task results must not hide in
`details` or a help popover. The narrow navigation disclosure is a separate use.

### UI copy

Use the native meaning of elements before adding explanatory copy: links navigate,
buttons act, labeled fields accept input, switches edit binary states, and tables
express comparable records. A read-only status remains a badge or text, not an
editable control. Do not move every removed paragraph into a new help button.

Write the object and outcome in familiar words. Remove explanations that merely
describe how to operate a clear control. Keep a short impact statement beside a
control when the consequence cannot be expressed by the control alone. Place field
errors beside the field; place a request failure beside the failed task. Never
remove information needed to understand authority or irreversible effects for
visual neatness.
Use familiar names such as My keys, My usage, My quota, Members and services,
Client configuration and Upstream connections. “Account” alone must not blur a
member identity, service identity and provider credential.
Codex, Grok and xAI API are product labels. Execution Plans, credential slots,
raw grants, provider origins and database IDs belong in secondary diagnostics,
not ordinary onboarding copy.

| Context | Preferred visible wording | Avoid |
| --- | --- | --- |
| People categories | `成员`, `管理员`, `服务账号`, `待确认` | A repeated sentence explaining each row's type. |
| Account-state action | `已启用` / `已停用`; confirmation `启用账号` / `停用账号` | An isolated “enable” fact that looks editable but has no control. |
| Setup selection | `选择成员与密钥` | `使用已有密钥` when the action actually opens a selection list. |
| Local file generation | `生成配置文件` | Wording that suggests it creates a key or verifies a task. |
| New secret and package | `换发密钥并下载配置包` | `创建安装包` when issuance is the consequential effect. |
| Task evidence | `尚无任务请求记录`, or the dated recorded outcome | `就绪` based only on a download or model-list response. |
| Routine data reads | Quiet background reads; show only an actionable failure or deferred update | A global refresh button, `刚刚更新` row or permanent freshness warning. |
| Request identifiers | `请求 ID`, with secondary diagnostic help | Backend field names as the main label. |
| Unknown mutation | `结果尚未确认`, with a read-only recovery action | A success claim or a retry that may repeat the mutation. |

Business verbs still mean exactly what the [product contract](docs/product/experience.md#setup-and-safe-verbs)
defines. If concise wording would hide a new secret, a changed binding or shared
upstream authority, keep the impact explicit. Do not display all backend fields
and then use folding to compensate for their volume.

### Presentation states and access

WCAG 2.2 AA is the baseline. Primary touch controls target at least 44 by 44 CSS
pixels. Use native validation, persistent labels, visible keyboard focus, logical
reading order and non-color state cues. Popovers and dialogs must fit small and
magnified viewports. Cancellation returns focus and preserves safe editable work.
Test semantics in both scripted and native form paths; a decorative component
must not create an inert action without JavaScript.

Pending actions show what is waiting. Cancellation of a browser wait must not
claim to cancel a server operation. Distinguish confirmed changes, unavailable
reads, stale retained facts, expired login and unconfirmed results. Display each
state near its affected task; routine success does not demand another banner.

## Do's and Don'ts

- Keep cyan action emphasis and pixel feedback across the whole shell and tasks.
- Keep light mode fully light, including selected navigation, popovers and code
  surfaces; use the separate indigo token set for dark mode.
- Group by user activity; make identity, useful facts and the next action scannable.
- Choose a component for its behavior, then apply Agency Relay's theme.
- Keep paths, the selected target and consequential impact directly visible.
- Use shared primitives and compositions. Change canonical tokens and the authored
  rationale at their owners, then run `pnpm run console:build`.
- Do not replace pixel structure with generic rounded forms or copy unsupported
  reference-screen features.
- Do not shrink text or controls to compensate for weak information organization.
- Do not treat every noun as a heading, every fact as a card or every action as a
  toolbar button.
- Do not hide required task content in folding containers or secondary help.
- Do not mistake a screenshot, test count or download for design approval or
  completed client work.
- Do not create a second token authority, hand-edit generated design values or
  disable a native check to make an agent proposal appear compliant.

Review normal, empty, long-name, filtered, denied, stale, expired-login,
unavailable and uncertain-result states in the [local preview](docs/develop/console-preview.md).
Functional checks follow [verification gates](docs/develop/gates.md). Human review
must assess hierarchy, density, control choice and visual coherence in addition
to correct task completion.
