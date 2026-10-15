# Surface Credit operations

This page specifies the explicit organization credit contract implemented by [`src/auth/credits.ts`](../../src/auth/credits.ts). [Release operations](release.md) own cutover and rollback; deployed acceptance and its evidence limits are recorded in [#336](https://github.com/ronhuafeng/agency-relay/issues/336).

## Meaning

Surface Credit is Agency Relay-owned request admission, separate from provider tokens, media measurements and Provisional Billing. Each exact Execution Plan owns its fixed `creditCharge`, currently zero or one. One credit is not a token, a dollar, an RPM allowance, a subscription balance or a hard cost cap.

Identity is `user_id + surface_grant + UTC calendar month`. All keys and key families belonging to one user share that month's surface usage. Rotation, rename, binding changes and new keys never reset usage.

## Effective policy

```text
personal explicit policy
 = unlimited | limited(N) | disabled
effective policy
 = personal explicit policy
 ?? organization limited default
 ?? disabled
```

`unlimited`, `limited(N)`, and `disabled` are distinct stored policies. A missing row, a very large integer, or a negative value is not Unlimited. Inheritance selects the organization default; it is not another spelling of Unlimited. A personal explicit policy wins over that default, so a personal Unlimited policy overrides an organization zero.

Defaults are D1 state controlled by admins, not Worker constants or environment values. Initialize Codex, Grok and xAI defaults to zero. An operator then explicitly configures the intended organization access before cutover.

Zero is a finite cap, not a missing override and not the same as disabled. A user's explicit zero wins over a positive default. A missing override inherits; removing an override means **Use organization default**, not Unlimited. If no personal policy and no organization default remain, admission fails closed.

The default is a per-member allowance, not one pooled organization budget. Changing it affects inheriting users, while explicit personal overrides stay unchanged. A positive xAI default delegates the explicit xAI team's provider authority to inheriting users; review [surfaces.md](../product/surfaces.md) before enabling it.

## Entitlement, remaining credit and changes

Explicit Unlimited enables the surface with no Agency Relay credit ceiling. A positive finite allowance enables it until the recorded cap is reached. A finite zero cap still admits a zero-charge operation and rejects a positive charge. Disabled, and a missing final policy, reject every charge including zero. Positive allowance with consumed credit at the cap means exhausted, not disabled.

Read models expose mode, effective allowance, source (`personal`/`organization`/`unconfigured`), consumed credits, remaining credits, period start and reset time for all three surfaces. Unlimited and Disabled have a null allowance; an unconfigured final policy is Disabled. Finite remaining credit is `max(0, allowance - consumed)`. Missing database reads are errors/unavailable, not successful zero balances.

Policy updates change the current monthly cap and subsequent admission; they do not grant an additional amount or rewrite historical consumption. Example: consumed 70, old cap 100, new cap 80 -> remaining 10. Lowering the cap to 50 leaves consumed 70 and remaining zero. Restoring inheritance does not erase those 70 credits.

A finite zero cap blocks positive-charge use without editing scopes or permanently revoking the key. Raising it can restore that use for otherwise valid scoped keys. New issuance and replacement require Unlimited or a positive finite allowance for every selected/copied surface, even when the current month is exhausted. A key does not itself confer additional allowance.

## Enforcement

Every supported plan, including zero-charge catalog/poll/control plans, first needs enabled-surface authorization. Do not retain the old zero-charge early return before entitlement. When a positive allowance is exhausted, a supported zero-charge operation may still run; it does not refill or consume credit.

For a positive charge, enforce the effective cap and increment usage atomically before provider dispatch. Missing defaults, malformed configuration and database failures must not select an Unlimited path. Two concurrent attempts competing for one remaining credit admit at most one.

Keep `429 surface_credit_exhausted` and a truthful UTC reset/Retry-After for a genuinely exhausted positive cap. Disabled-surface denial must be distinguishable from monthly exhaustion and must not promise that the next reset will enable it. Preserve protocol-specific error rendering. No rejected authorization/admission may dispatch to the provider.

Credit represents admitted attempts rather than successful provider output. Do not add refund-on-provider-error, token-based billing or stream parsing as part of quota inheritance. Keep the plan-owned charge and existing metering boundaries; a changed charge schedule would require a separate product decision.

## Fact-backed reconciliation

The Credit month and admission timestamp are selected after Credential Slot
resolution, when admission begins. Request-audit and Provider usage retain their
existing request-start attribution. A request spanning midnight does not make
these different time scopes interchangeable.

[Domain language](../../GLOSSARY.md) distinguishes Credit Admission, Terminal
Confirmation and Provider Usage Measurement. The Provider Attempt Module owns
one Mini-generated attempt identity; caller correlation can repeat and is not
the accounting identity.

Every positive-charge admission stores the actual charge, exact user/key,
surface, Execution Plan, UTC period and admission time. That immutable admission
fact and the monthly counter increment share one D1 transaction. A rejected
conditional increment creates no fact; a fact-write failure rolls back the
increment. Zero-charge operations still check entitlement but do not create a
charged-admission fact.

The first fact-backed debit freezes the period's previous consumption as its
Opening Credit Balance. New periods start at zero. A period without fact-backed
admissions retains its existing consumption as an uncaptured historical balance.
No request identity, terminal result or provider measurement is fabricated for
that balance. Old writers that change a captured counter without a fact create
an explicit reconciliation difference; the reader does not absorb it into the
opening balance.

For the same user, surface and UTC month:

```text
consumed credits = opening credits + recorded admission credits
recorded admission credits = terminal-confirmed credits + terminal-unconfirmed credits
```

The first equality is a checked invariant, not a derived definition of the
opening balance after capture. Terminal-unconfirmed means no retained terminal
confirmation; do not label it running, failed, refundable or unattempted without
separate evidence. The terminal confirmation commits with the matching audit
and Responses aggregate, never with another Credit debit. It survives normal
request-audit retention. Provider usage remains a separate measurement.

Existing credit reads expose source-qualified reconciliation totals, the opening
balance capture flag and a signed balance difference. Database read failure
remains unavailable, not a balanced zero. Historical consumption is visible but
does not acquire request-level coverage. A schema-compatible older Worker may
serve recovery traffic, but its unreceipted debits do not satisfy this model's
forward reconciliation contract.

`charged_admissions` counts receipt records; `recorded_admission_credits` sums
their frozen charges. `admitted_attempts` is the existing monthly counter and
can include history without receipts. None of these counts is a provider token
measurement or a monetary charge. Confirmation counts a persisted terminal
outcome, including provider rejection or transport error, not just success.

The [focused state model](../../tests/models/CreditFacts.tla) checks admission
conservation and cap safety for two owners, two months and competing attempts.
Its missing-receipt witness rejects a counter-only commit. It permits absent
terminal confirmation and makes no provider-progress or unbounded refinement
claim. Real SQL, deployed D1 readback and completed provider tasks remain required.

### Live acceptance

Given a known deployed revision and dedicated keys bound to one approved test
user, complete one text Responses operation on each Codex, Grok and xAI surface,
then one Grok provider-rejected model request. Make one wrong-grant request and
use the required model catalog reads as zero-charge controls. No permissions,
allowances, bindings or upstream credentials change.

The proof budget is four charged request invocations, one denied invocation and
the necessary free catalog/readback calls, without runner retries. Read the same
user's operator credit projection before and after. Require real text and
successful terminal completion for positive tasks, a real provider rejection
for the negative model case, preserved effective opening balances, exact per-surface
admission/terminal deltas and zero balance differences. Poll only readback for
bounded asynchronous persistence; never repeat paid operations to obtain a pass.
Concurrent unrelated use of this dedicated identity makes exact-delta acceptance
inconclusive, not permission to widen the window or discard rows.

Before first capture, the existing consumption is the effective opening balance.
The first receipted charge freezes that value; its capture flag may change from
false to true. Later captured openings must not change. Each credit projection
is one database snapshot. Fix the UTC month for the proof; month rollover makes
the proof inconclusive. Internally correlate the four admissions to the tested
invocations; counts alone cannot distinguish unrelated traffic.

Retain only revision/deployment identities, counts, status codes, coverage and
booleans. No prompts, responses, tokens, key hashes or provider resource IDs.
This establishes the new model for those operations, not a reconstructed
historical bill or a full Live workflow rerun. Existing un-attributed historical
differences remain explicitly outside request-level coverage.

## Operator and member interfaces

Normal administration uses a Feishu-authenticated active admin in Quotas/People. Members see only their own state through `GET /me/credits`. `/me` is personal for admins too.

Existing operator paths are the transition seam:

| Path | Target meaning |
| --- | --- |
| `GET /admin/users/:userId/credits` | All effective surface states, not only explicitly limited rows |
| `PUT /admin/users/:userId/credits/:surface` | Set a personal policy: `{monthly_allowance}` for a finite cap, or `{mode:"unlimited"}` / `{mode:"disabled"}` with no allowance |
| `DELETE /admin/users/:userId/credits/:surface` | Remove override and inherit organization default |

Here `:surface` is `codex`, `grok` or `xai`. Organization default management is a new admin-only capability. The operator API on `api.trustedtunnel.app` continues requiring `ADMIN_SECRET` for bootstrap/recovery; a console session never authorizes that host's operator routes. Do not advertise new endpoints as deployed until their implementation has shipped.

Every default/override mutation records actor, scope, previous/new mode and finite value, and result in canonical audit. Removing a policy must preserve usage. UI says Unlimited only for an explicit Unlimited policy and does not invent a remaining balance. It names whether a finite value is personal or inherited.

The organization settings form saves all three defaults in one database transaction with per-service audit records. Current administrator authority and all displayed prior caps must match before any default changes. A stale cap, missing service or audit failure leaves the complete settings unchanged. This does not reset recorded use or modify personal overrides. Per-service operator calls use the same commit boundary for their one requested default.

## Verification and cutover

Use synthetic users with real D1-compatible SQL tests for inheritance, explicit zero, zero-charge denial, positive-but-exhausted free operations, policy deletion, cap lowering/raising, month rollover, shared use across keys, database failure and concurrent last-credit admission.

A bounded deployed check may use a temporary user and small explicit allowances, then confirm metadata and revoke test keys. Do not publish secrets, prompts, output or provider credentials. Do not mass-reset usage to simplify migration.

Before Phase B, inventory existing missing policies. Existing Unlimited usage was not necessarily recorded in the credit ledger; do not invent historical consumption from token or monetary totals. Record this measurement limit in the release evidence. Explicit defaults and reviewed personal overrides determine the forward policy.

## Completed legacy policy migration

The one-time cutover made a usable legacy key grant with no personal policy explicitly Unlimited. Existing finite caps, including zero, kept their values and recorded consumption. A surface with no usable grant and no personal policy became disabled; disabled accounts were not repaired. This mapping preserved existing access at cutover and is not the policy for later accounts or newly granted surfaces.

The [recorded application](https://github.com/ronhuafeng/agency-relay/issues/336#issuecomment-5926312735) wrote 66 mode rows and their audit records on 2026-10-01 and recorded post-apply parity as ready. That result belongs to that checkpoint; it does not establish current row-by-row parity. The [retired implementation](https://github.com/ronhuafeng/agency-relay/blob/40211ae64e211f97bcdc1a98b6bdb07b670b3927/src/auth/credit-migration.ts) remains available for historical audit and recovery review, not as a supported command to reapply.

Current reads, admission, issuance and replacement use explicit personal policies and organization inheritance. An existing key grant does not turn a missing policy into Unlimited. Inspect effective state through the operator credit read above and make any intended policy change through the normal audited policy interfaces. Do not rerun the old grant-based inference after key, account, policy or default changes, or during code rollback.

The finite-policy and explicit-mode tables, their mutual-exclusion constraints, recorded consumption and migration audits are retained state, not temporary migration machinery. Retiring the helper does not change keys, their families, hashes, owners, names, expiry, scopes or sticky bindings, and does not require a schema migration.
