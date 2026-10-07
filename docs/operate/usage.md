# Usage, provider metering and provisional billing

Agency Relay reports observed provider measurements and request outcomes. It does not settle bills, generate invoices or infer missing measurements. The organization redesign changes who may read reporting, not the provider observation contract.

## Query scope

Normal members use My usage / `GET /me/usage`. The server fixes the user filter to the authenticated internal `user.id`. Reject or disregard attempts to inject another user or a global reporting scope without ever broadening the query. Counts, summaries, pagination, exports and media rows must remain personal. An administrator's `/me/usage` is personal too.

Global or selected-user reporting belongs to an active admin console session. The operator seam is:

```http
GET https://api.trustedtunnel.app/admin/usage
Authorization: Bearer <ADMIN_SECRET>
```

Use that bearer only for protected operator work, not normal browser login. The existing query requires one explicit time mode and a limit; no query parameters returns a machine-readable guide rather than reading D1.

Supported administrator filters are one of `scope=all`, `day=YYYY-MM-DD`, or `from=YYYY-MM-DD&to=YYYY-MM-DD`; optional exact `user_id`, `route_profile_id`, provider-reported `response_model`; and `limit` from 1 to 1000. Both APIs use the same exact UTC date parser. `scope=all` on `/me/usage` means all time for the current user only, never all users. The personal API retains its no-parameter all-time default and default row limit of 100; explicit `limit` uses the same 1–1000 bounds.

Compatibility changes: explicit `from`/`to` ranges are now limited to 3,660 inclusive UTC days, independently of the trend UI's 30-day maximum. Earlier valid ranges of at most that length, valid `day`, and explicit `scope=all` retain their meaning; larger ranges must be split or use explicit `scope=all`. Impossible dates, repeated/unknown parameters, conflicting modes, incomplete or inverted ranges, and oversized ranges produce repairable 400 responses before database reads. Personal queries no longer silently prioritize `day` over conflicting modes or turn a partial range into all time. A database read failure remains unavailable (503), never an empty result.

## Daily trends

Usage pages offer only `range=7d` and `range=30d`, inclusive of the current UTC day. Exact start/end dates and the unfinished current day appear on chart axes and daily rows; routine read timestamps are not displayed. Legacy `today`/`all` page ranges return a recoverable 400; the API modes above remain available. Administrators use organization Usage or its exact `person`, `plan` and `model` URL filters; the model filter applies only to Responses, not media. These same filters reach summaries, daily SQL aggregates, detail rows and the export. Personal Usage, including an administrator's personal area, fixes the owner on the server and does not ship an organization aggregate.

Daily trends aggregate the complete matching ledgers in SQL, independently of the 100 personal / 250 administrator displayed groups. Exports default to 100 personal groups and 1000 administrator groups per ledger. A truncation note explains omitted detail groups; it does not imply truncated trend totals. Browser-local text search affects displayed detail rows only.

Requests/errors are recorded Responses outcome counts. After a successful read, a day without rows can show recorded zero; this does not establish absence of traffic at all ingress routes. Tokens, costs, outputs and durations each retain their own measurement coverage. No measurements remains unknown; measured zero and partial coverage are distinct. Multi-day coverage sums numerators and denominators rather than averaging daily percentages. Only observed plan/capability series are emitted; opaque plans never receive invented zero records.

Responses trend summaries remain grouped by exact Execution Plan; media also retains capability. Models remain in the bounded detail groups. Request/start-count charts have keyboard-accessible daily tables with values and coverage, including explicit unknown text. Costs have no shared cross-authority/surface/capability axis; Agency Relay credits are separate admission units. Video starts belong to their start day and first terminal observations to their observation day; polling is not a new event. Image measurement opportunities are recorded starts; video opportunities are first completed, failed or expired terminal observations.

Range selection sits beside the charts and reuses latest-intent transport. A failed switch retaining content names its old UTC range and stale state; superseded responses cannot replace newer intent. Daily tables expand inline; without script they remain visible. Unobserved service/media categories are omitted, and one observed series uses the available width.

Visible Usage pages read their current scoped Agency Relay ledgers in the background every five minutes. Read clocks alone do not replace the DOM. Changed data waits while a draft, filter, focused control, selected tab or open disclosure is in use; a compact status reports deferred data or a failed read. Normal reads stay quiet. Browser refresh provides an explicit new read. These statistics do not promise real-time upstream delivery. Background reads perform no provider calls, collection, historical backfill or recalculation.

## Ledgers

| Ledger | Grouping | Meaning |
| --- | --- | --- |
| `usage_daily` | User + UTC day + Execution Plan + response model | Responses outcomes, tokens, provider cost ticks and coverage |
| `media_usage_daily` | User + UTC day + Execution Plan + capability | Image/video outcomes, outputs, duration, cost ticks and coverage |
| Surface Credit usage | User + surface + UTC month | Agency Relay admission units; not provider measurement |
| `operator_mutation_audit` | Actor + operation + target + time | Canonical control-plane changes; not a usage ledger |

The retained `route_profile_id` reporting column identifies the exact Execution Plan for current data. Do not collapse the same model reached through Grok and xAI into one authority bucket. `response_model` is provider-reported and applies to Responses rows, not media rows.

The non-routable `codex.historical.responses` attribution preserves old data whose source can be identified without inferring a live plan. Unattributed `N/A` rows and historical missing coverage stay explicit; organization migration must not rewrite them as newly observed measurements.

Image requests belong in the media ledger, not synthetic zero-token Responses rows. Video start and first terminal observation retain exactly-once accounting. User email migration retains internal user IDs so historical ledgers stay attached to the account without copying records.

## Coverage

Read aggregates alongside their measurement counts:

```text
total_tokens                 + token_measurements
provider_cost_usd_ticks       + cost_measurements
outputs                      + output_measurements
video_seconds                + duration_measurements
```

Zero coverage means unknown, not free and not an observed zero. Preserve accumulated historical values but display an em dash where sufficient measurement is absent. A reported cost of exactly zero is measured and increments coverage; partial token details without a total do not establish an observed total of zero.

Responses cache read share is `cached_input_tokens / input_tokens`, only with token measurement coverage and a positive denominator. Display coverage with the ratio; no coverage or zero denominator gives an em dash. Browser-local filters describe only displayed rows and cannot alter server totals or user scope.

## Provisional Billing

`provider_cost_usd_ticks` retains the exact provider-returned integer from `usage.cost_in_usd_ticks`. The existing reporting contract converts one tick as `10^-10` USD and labels the result **Billing · Provisional / Provider-reported metered value**. No amount is derived from public prices, tokens, media size, model name or guesses.

Keep ChatGPT and Grok subscription authorities distinct. ChatGPT backend rows without a per-request amount have unavailable billing, not an estimate. Grok/xAI measured values may be subtotaled within their subscription authority while retaining exact surface/capability breakdown and coverage. Multiple physical credentials do not justify inventing per-account dollar attribution absent ledger evidence. There is no fake unified cross-provider bill, account balance, savings total, settled charge or invoice.

## Observation boundary

Only plans declaring `responses`, `image` or `video` inspect bounded provider metadata. Opaque Chat, speech, catalogs, Files and realtime routes do not acquire measurement because the UI wants a total. `none` stays none until an exact usage contract is proven.

Observation follows the client-driven transparent stream. It does not retain prompts, generated text, reasoning, media, temporary URLs, raw provider identifiers or whole bodies. Parse, size, encoding, cancellation and persistence failures leave coverage unknown and cannot replace a successful client result. Control-plane transaction audit must not turn this non-interfering observer into a blocking provider-response dependency.

## Retention and safe operations

`request_audit` is bounded request metadata; durable reporting uses daily ledgers. `video_jobs` and Files HMAC state enforce their specific lifecycle/ownership contract, not billing. Do not reuse request-retention cleanup to erase canonical member or audit history without a separately owned retention policy.

Schema/debug work may use read-only D1 queries. Routine humans use scoped console reporting. Required data-read failures render unavailable, not normal zero usage. Store only sanitized request IDs, counts, coverage, timestamps and verdicts in release evidence.

See [credits](credits.md), [organization access](../product/organization-access.md), [Responses development](../develop/responses.md), and [verification](../develop/gates.md).
