# Test authoring and refinement

These rules apply when writing, reviewing, repairing or deleting tests under `tests/`. They govern **test quality**, not test selection or release admission. [Root instructions](../AGENTS.md) retain repository truth ownership; [verification gates](../docs/develop/gates.md) exclusively own layers, native commands, CI and evidence limits. Accepted product and visual contracts remain with their existing owners.

## Start with the contract and an independent oracle

Before changing a test, identify the consumer-visible result, the authority/object identity, and the invariant it must protect. State:

1. A valid behavior the test must accept.
2. A plausible wrong behavior it must reject.
3. An equivalent correct implementation change it must tolerate.

Obtain expected results independently of the implementation being exercised. Repeating the implementation's calculation, importing its mutable default as the expected value, or asserting only that its own emitted text matches itself does not provide an independent oracle. Use discriminating counterexamples rather than freezing incidental function names, caller lists, DOM order, class counts or current layout.

Preserve an accepted published protocol, fixture identity or historical compatibility requirement when real clients depend on it.

## Choose the smallest sufficient proof

Keep permutations of pure rules at the owning module/interface. Verify UI wiring through rendered controls and observable actions, and reserve a bounded number of real browser/edge/provider journeys for effects that cannot be proven at a lower layer. Do not replay every permutation at every layer.

Test the implementation through the interface its real callers use. Doubles belong at explicit external seams; do not replace the router, credential selector, quota transition or other subject under test with a lookalike fixture and then count calls to it. A Mock cannot prove D1 atomic admission, TokenAuthority persistence, actual provider capabilities or a transaction spanning systems. Use real SQL-backed contracts where the invariant requires them.

Follow writes and denial to an authoritative consumer endpoint. A 200 response, button click, changed row count or emitted event alone does not prove the operation's effect. Keep deterministic synthetic proofs distinct from opt-in live provider and deployed release evidence. Skipped, missing, stale or unrun evidence never becomes a pass.

## Assert the correct identity and authority

Bind assertions to the exact user, session, key family, requested surface, immutable Execution Plan, selected credential slot and request under test. Where mix-ups matter, add a second identity, revoked authority, wrong method/path/host, or stale generation as a counterexample.

- A disabled account or revoked API key must fail its next protected request; rejected dispatch must not reach a provider.
- A new credential default must not silently alter an existing key's sticky binding.
- A denied operation must not leak another user's data or record a false successful mutation.
- Concurrency and last-credit cases must prove the allowed final state in SQL, not just a mocked method sequence.
- Do not assume a zero-row conditional write undoes a batch, or that D1 and TokenAuthority share an atomic transaction.

For UI tests, prefer accessible task-local selectors and visible outcomes. A coincidental matching phrase elsewhere on the page is not evidence. Avoid `first()` as a workaround for an ambiguous owner. Assert pixel dimensions or visual presentation only when the accepted design owns that constraint. Treat loading, stale, unknown, disabled, rejected and successful states as distinct outcomes.

## Own asynchronous work

Use request/event barriers or observable committed state to control races, not arbitrary sleeps. A delayed result must be attributed to the request, page and account that initiated it after navigation, retry or replacement.

Every held request, listener, timer and background operation must have bounded ownership and failure-safe cleanup. Stop creating work, release barriers, drain owned in-flight operations, then close its page/context. Remove only owned handlers and restore changed local fixtures. Preserve both the primary assertion failure and any cleanup failure. Increasing timeout/retries must not be the default repair for uncertain readiness.

## Diagnose, refine and remove

Classify a failure before changing code: product-contract regression, invalid test/oracle, or environment/fixture defect. Keep the smallest secret-safe diagnostic evidence in the owning PR/Issue; an unexplained failure is not automatically flaky.

For a repair, restate the protected invariant, the incorrect counterexample, and the equivalent correct change. Re-run the wrong case and the relevant success, rejection, cancellation and stale-result paths. Do not weaken assertions, add skip/only, mask exit codes, or change CI to manufacture green results.

Merge/delete a redundant test only after identifying its unique guarantee and the surviving executable owner. Preserve security, privacy, destructive-action and backward-compatibility guarantees. Verify the affected native gates on the actual candidate and report failed/unverified evidence as such.

## RSI tail: refine principles, not incident history

After a test repair or a demonstrated weak oracle, decide whether it establishes a general reusable authoring principle. If yes, **merge or replace** the relevant rule here, stating its scope and rationale; do not append an incident-specific blacklist, a second test framework or a copy of the CI matrix. If no general principle emerged, leave this file unchanged.

Keep incident traces, experiments and one-time decisions in the owning Issue/PR. A refined rule must still reject the demonstrated wrong behavior without forbidding an equivalent correct implementation.