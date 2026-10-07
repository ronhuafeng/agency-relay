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
| `usage_daily` | User + UTC day + Execution Plan + response model | Responses outcomes, tokens, separate provider / API-equivalent USD ticks and coverage |
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
api_equivalent_usd_ticks      + api_equivalent_measurements
outputs                      + output_measurements
video_seconds                + duration_measurements
```

Zero coverage means unknown, not free and not an observed zero. Preserve accumulated historical values but display an em dash where sufficient measurement is absent. A reported cost of exactly zero is measured and increments coverage; partial token details without a total do not establish an observed total of zero.

Responses cache read share is `cached_input_tokens / input_tokens`, only with token measurement coverage and a positive denominator. Display coverage with the ratio; no coverage or zero denominator gives an em dash. Browser-local filters describe only displayed rows and cannot alter server totals or user scope.

The Token metric's “已记录 N/M 次请求” describes measurement coverage, not cache usage. Cache read share is separate. Amounts have independent coverage; token coverage does not establish price coverage.

## Provisional Billing

`provider_cost_usd_ticks` retains the exact provider-returned integer from final `usage.cost_in_usd_ticks`. One tick is `10^-10` USD. Grok/xAI display **上游计量金额**: provisional provider-reported value, not a settled invoice. It already includes measured hosted-tool fees. Do not add a token-price estimate or sum cumulative stream totals.

Codex Responses display **API 费率折算**: recorded text-token usage valued at official OpenAI **Standard API-key rates**, not ChatGPT subscription cash spend. The fixed Standard policy does not assert the upstream's actual service tier. It excludes separately charged tools, media and unobserved categories. It is stored in `api_equivalent_usd_ticks` with independent coverage and never fills a missing provider amount.

The versioned snapshot lives in [the pricing module](../../src/usage/api-value.ts). Each physical request uses its provider-reported exact model ID and sufficient input/cache/output buckets. GPT-5.6+ requires explicit cache-write tokens. Unknown models, missing/invalid buckets and unsafe values remain unpriced. Reasoning is already in output. Eligible models use the full-request long-context rate only above 272,000 input tokens. Calculate before daily aggregation, in integer ticks; store price version and cache writes beside the audit amount. Price updates affect new observations only. No inferred historical backfill.

Keep ChatGPT and Grok authorities distinct, including exact surface/capability breakdown and coverage. Multiple physical credentials do not justify inventing per-account dollar attribution absent ledger evidence. There is no unified cross-provider bill, balance, savings total or invoice. Surface Credits remain admission units, not USD.

## Cost calibration evidence

This research was checked on 2026-10-07 and supports the separate API-equivalent policy above. Public prices cannot replace an absent provider measurement or prove a settled subscription charge.

### xAI API and Grok Build

The [official xAI price page](https://docs.x.ai/developers/pricing) lists these standard global API rates in USD per million tokens. `grok-build-0.1` is a model ID, not a price for every request made by the Grok Build client.

| Model | Prompt below 200k: input / cached input / output | Prompt at least 200k: input / cached input / output |
| --- | --- | --- |
| `grok-4.7`, `grok-4.6` | 2 / 0.50 / 6 | 4 / 1 / 12 |
| `grok-build-0.1` | 1 / 0.20 / 2 | 2 / 0.40 / 4 |

Long-context rates apply to all tokens in the request. The same page lists a 2x priority multiplier and a 1.1x US regional multiplier. Grok 4.7 Fast is available only in Build/Cursor and uses their plan billing: below 200k, 4 / 1 / 12; above 200k, 6 / 1.50 / 18. Its section says “above”/“exceeds” 200k, unlike the standard table's inclusive threshold; the exact Fast boundary is not resolved here. These are different billing contexts, not interchangeable model prices. [xAI pricing](https://docs.x.ai/developers/pricing)

For the official xAI API, `usage.cost_in_usd_ticks` is the request's charge after discounts and includes token and server-side tool costs. Image and video responses use this field too. One USD is `10^10` ticks. The xAI SDK's streaming chunks carry running request totals; only the final total must be added across requests. REST Chat Completions needs `stream_options.include_usage=true` and reports cost in its final usage chunk. Do not add hosted-tool fees again. [xAI cost tracking](https://docs.x.ai/developers/cost-tracking)

The source review below is pinned to upstream [Grok Build `f0e3be1100ef5252488e3be8bb0e91cf68d8c305`](https://github.com/xai-org/grok-build/commit/f0e3be1100ef5252488e3be8bb0e91cf68d8c305). The installed executable reports `1.0.44 (5b807183dd79)`, but its matching source was not resolved from local Git objects or the public repository. These findings do not establish that installed build's behavior. No paid request was made.

- The reviewed normal response path uses the provider's amount, not token counts multiplied by a hardcoded model price. Responses extracts a signed integer from terminal `response.completed`/`response.incomplete` metadata. It also replaces `usage.total_tokens` with live context length where available; that context count is not a dollar measurement. Chat Completions keeps the last valid cumulative cost instead of summing stream chunks. [Responses capture](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-sampler/src/client.rs#L124-L157), [Chat Completions capture](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-sampler/src/stream/chat_completions.rs#L116-L125)
- Conversion uses ticks divided by `1e10`. Build discards wire costs of zero or less as unreported; its source comment says the REST layer supplies zero for absent cost. Agency Relay instead counts an explicit zero as measured. The comment alone does not prove the installed Gateway's zero semantics or justify changing Agency Relay's contract; resolve that exact contract before copying either rule. Exact decimal representation requires integer ticks, not the USD float. [Normalization](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-sampling-types/src/conversation.rs#L858-L863), [USD conversion](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/extensions/notification.rs#L308-L314)
- Main model calls and completed subagent usage feed the session ledger; prompt attribution can be narrower. Integer addition is saturating, not unbounded. Persisted turn rows are deltas, and the session is their aggregate. Adding a parent total to its children, or adding session totals to turn/model breakdowns, can double-count the same cost. [Ledger arithmetic](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-chat-state/src/usage.rs#L45-L152), [Subagent folding](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-chat-state/src/actor/mutations.rs#L449-L493), [Turn persistence](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/session/usage_file.rs#L253-L315)
- Partial/incomplete prompt reports withhold cost. Headless JSON exposes exact ticks beside USD only when its trust checks pass; `streaming-messages-json` instead substitutes `0.0` for unavailable cost. The TUI session block rounds USD to four decimals; the status line uses two and hides values below $0.005. None of these displays proves zero charge. [Cost projection](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/extensions/notification.rs#L321-L406), [Messages fallback](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-pager/src/headless/reducer/messages/usage.rs#L65-L112), [Session display](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-pager/src/app/status_blocks.rs#L234-L241), [Status display](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-pager/src/views/status_line/segments.rs#L18-L104)
- A complete flag does not prove complete spend. The source notes an ordinary missing-usage response can remain unmarked. Its compaction output and standalone image/video response types omit cost, so these paths do not establish coverage in the session USD ledger. Failed or cancelled requests without final usage also cannot be priced from these totals. [Missing-usage gap](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/session/acp_session_impl/sampler_turn.rs#L2171-L2198), [Compaction output](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/session/helpers/session_compact.rs#L627-L696), [Image response](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-tools/src/implementations/grok_build/image_gen/mod.rs#L381-L395), [Video response](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-tools/src/implementations/grok_build/video_gen/mod.rs#L862-L878)

Do not apply the API's actual-charge claim to subscription OAuth. Grok's included usage is a shared plan allowance; Extra Usage Credits are separate. Build's billing API has percentage and USD-cent fields, distinct from per-response ticks. The inspected sources do not prove that OAuth ticks equal extra cash paid, invoice totals or allowance depletion. [Grok usage FAQ](https://docs.x.ai/grok/faq), [Build billing fields](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/extensions/billing.rs#L19-L96)

Build's headless `usage.input_tokens` is the ordinary-input bucket: full input minus cache reads and cache writes. Agency Relay retains full input, with cached input as a subset. Do not subtract cache reads twice when comparing these reports. [Headless token projection](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/extensions/notification.rs#L321-L366), [Agency Relay observer](../../src/proxy/observation.ts#L311-L322)

### OpenAI API and ChatGPT subscriptions

“ChatGPT API pricing” needs an exact authority: the public OpenAI API has a USD price table; ChatGPT-authenticated Codex has a subscription/credit contract. They are not the same bill. The [official OpenAI API price table](https://developers.openai.com/api/docs/pricing) lists these Standard text rates in USD per million tokens:

| Model | Short input | Cache read | Cache write | Short output | Long input | Long cache read | Long cache write | Long output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `gpt-6.1-sol` | 2 | 0.10 | 2.50 | 10 | 4 | 0.20 | 5 | 15 |
| `gpt-6-sol` | 2 | 0.20 | 2.50 | 10 | 4 | 0.40 | 5 | 15 |
| `gpt-5.5` | 5 | 0.50 | — | 30 | 10 | 1 | — | 45 |
| `gpt-5.4` | 2.50 | 0.25 | — | 15 | 5 | 0.50 | — | 22.50 |
| `gpt-5.3-codex` | 1.75 | 0.175 | — | 14 | — | — | — | — |

Short context is at most 272K input tokens; long context is above 272K. A dash is no separately listed rate, not a measured zero or a claim that the model supports that context. Select the exact model and price version. Fast, Ultrafast, Batch, Flex, regional processing and tool/media prices are separate; do not apply one universal multiplier or use Standard rates to assert actual spend. [OpenAI pricing](https://developers.openai.com/api/docs/pricing)

For text-only API list-price valuation, let `I` be full input, `C` cache reads, `W` cache writes, and `O` full output. The disjoint input buckets are ordinary input `I-C-W`, read `C`, and write `W`. Cache-write pricing applies to GPT-5.6 and later; it replaces the ordinary rate for those tokens, not an added full-price charge. Use the reported `input_tokens_details.cache_write_tokens`; do not assume an absent count is zero where that bucket can be charged. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

```text
API-equivalent USD = ((I-C-W)*input_rate + C*read_rate
                      + W*write_rate + O*output_rate) / 1,000,000
                     + separately proven tool/media charges
```

For a model without separate cache-write pricing, use its documented input/read contract instead. Reasoning tokens are already part of output tokens; do not charge them a second time. A returned service tier may differ from the requested tier. [Reasoning usage](https://developers.openai.com/api/docs/guides/reasoning), [Returned service tier](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)

Codex credit billing has no separate cache-write charge. Credit purchase prices and discounts depend on the plan/agreement, and public credit rates alone do not determine included subscription usage. Thus API-equivalent USD is a reference valuation, not ChatGPT subscription cash spend. API-key organizations can reconcile financial totals through `GET /v1/organization/costs` with an OpenAI admin key; Agency Relay's `ADMIN_SECRET` and ChatGPT OAuth are not that credential. Its grouped cost data does not by itself establish per-Agency-Relay-user charges. [Codex pricing](https://learn.chatgpt.com/docs/pricing), [Organization Costs API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs)

### Agency Relay calibration result

The current observer preserves integer provider ticks, and the formatter uses decimal digits rather than rounding each request to cents. Responses and media have separate ledgers and cost coverage. These mechanisms support precise **observed metered value**, not a complete bill across unobserved routes or interrupted streams. A paid upstream attempt can have no final measurement. [Observer](../../src/proxy/observation.ts#L311-L334), [Accounting](../../src/db.ts#L777-L831), [USD formatter](../../src/admin/format.ts#L39-L44)

Responses capture preserves reported cache-write counts for new observations. Fixed Standard valuation does not need actual service tier. Historical daily model totals erase per-request thresholds and may lack write counts, so a price table alone cannot repair missing history. Grok Build totals are not an independent complete reconciliation source because of the gaps above. [Capture](../../src/proxy/observation.ts), [Per-request accounting](../../src/db.ts)

Integer precision has a limit. The observer and per-request valuation accept only JavaScript safe integers. At `10^10` ticks per USD, the maximum safe amount is $900,719.9254740991. Responses summary normalization rejects an unsafe amount instead of presenting zero; the formatter also rejects unsafe amounts. This is bounded exact metering, not unbounded financial arithmetic. [Capture](../../src/proxy/observation.ts), [Summary normalization](../../src/db.ts), [USD formatting](../../src/admin/format.ts)

The calibration decision is to keep three meanings separate:

- **Provider-reported metered value:** use final ticks once per physical request; retain measured, missing and partial coverage. Do not add prices or hosted-tool fees to an already inclusive amount.
- **API-equivalent value:** use versioned official Standard rates and sufficient per-request metadata before daily aggregation. Label its assumed tier, included cost categories and coverage; never write it into `provider_cost_usd_ticks` or use it to fill a missing provider measurement.
- **Settled charge:** require the relevant provider's financial authority and account contract. Neither public prices nor subscription ticks establish a cash invoice. Agency Relay Surface Credits remain admission units, not USD.

No historical recalculation or settled-bill reconciliation is part of this reporting contract.

## Observation boundary

Only plans declaring `responses`, `image` or `video` inspect bounded provider metadata. Opaque Chat, speech, catalogs, Files and realtime routes do not acquire measurement because the UI wants a total. `none` stays none until an exact usage contract is proven.

Observation follows the client-driven transparent stream. It does not retain prompts, generated text, reasoning, media, temporary URLs, raw provider identifiers or whole bodies. Parse, size, encoding, cancellation and persistence failures leave coverage unknown and cannot replace a successful client result. Control-plane transaction audit must not turn this non-interfering observer into a blocking provider-response dependency.

## Retention and safe operations

`request_audit` is bounded request metadata; durable reporting uses daily ledgers. `video_jobs` and Files HMAC state enforce their specific lifecycle/ownership contract, not billing. Do not reuse request-retention cleanup to erase canonical member or audit history without a separately owned retention policy.

Schema/debug work may use read-only D1 queries. Routine humans use scoped console reporting. Required data-read failures render unavailable, not normal zero usage. Store only sanitized request IDs, counts, coverage, timestamps and verdicts in release evidence.

See [credits](credits.md), [organization access](../product/organization-access.md), [Responses development](../develop/responses.md), and [verification](../develop/gates.md).
