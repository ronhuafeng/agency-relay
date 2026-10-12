# Live validation

All files under this directory use actual Agency Relay API keys and deployed Provider/Worker endpoints. They **must not** fall back to mocks or interpret a Provider-side failure as task completion.

## Selection and ownership

`.github/workflows/live.yml` is the single entry point. Each current `tests/live/**/*.test.ts` file is one fixed Job. There is no matrix. `.github/actions/setup-live/action.yml` only prepares the pinned Node/pnpm environment; it does not select or wrap tests.

`needs` follows a result dependency, not a directory:

- Reachability is `/healthz` on the three production hosts. Every other Job waits for it.
- Codex runs Catalog, then Contract, then Responses. Realtime and the Codex CLI wait for Responses.
- Grok runs Catalog, then Responses. Audio, Files, Images, Videos and the Grok text CLI wait for Responses. The Grok image CLI waits for Images. The Grok video CLI waits for Videos. The video owner check uses the separate `agency-relay-2` Grok key. It does not create a user or use the admin secret.
- xAI runs Catalog, then Responses. Audio, Files, Images, Videos, WebSocket, Resources and Public URL wait for Responses. Responses also receives the Grok surface key because that file checks cross-surface denial.
- Authority · Access waits only for Reachability. Authority · Credits waits only for Reachability; it creates its own user.
- Accounting · Billing waits until every Job that can write the Codex Responses, Grok Responses, Grok Images or Grok Videos ledgers has finished. It still runs when one of those Jobs failed, and it does not run after cancellation. Its own calls must be the only new rows in that window.

A scheduled run or a manual run with all diagnostic selectors false starts the whole graph. A failed parent skips its children. Each file runs once. A new Live file needs its own Job and an explicit `needs` edge. Do not add it by widening a directory glob.

Manual `credit_reconciliation_only=true` with the other selectors false runs only
the fixed Credit reconciliation Job: three successful Responses invocations,
one Grok provider-rejected model invocation, one wrong-grant denial and required
free catalog/operator reads. It changes no permissions, policies or bindings and
has no paid retries. Its dedicated-user operator snapshots prove projection
deltas only. Final acceptance also requires independent, exact-owner D1 receipt
and audit identity readback by the release operator, as specified in
[Credit operations](../../docs/operate/credits.md#live-acceptance). A Job PASS alone
is not a complete receipt-identity proof or a full Live PASS.

A manual run with `realtime_only=true` runs only Codex · Realtime, independently
of the Responses dependency. Reachability and its descendants, including Billing,
are not selected. This diagnostic run uses only the existing Codex surface secret
and makes one Realtime creation call without runner retries. It proves neither
the skipped dependencies nor full Live acceptance. ICE/DTLS/data-channel states
and allowlisted candidate counts are diagnostics, not substitutes for the caller
transcript and returned audio. Raw SDP, candidates, transcript and audio remain
in memory and are not uploaded as artifacts.

Manual `audio_diagnostic=true, realtime_only=false` selects one xAI STT WebSocket
using the same checked-in spoken fixture and outcome oracle as the normal
WebSocket gate. No TTS, HTTP STT or catalog call runs. All normal graph jobs are
unselected. The job emits fixture lengths/format, event counts and transcript-match
booleans only. Success establishes this STT operation, not full Audio or Live
acceptance. This selection needs separate operator authorization; it does not
retry the full graph.

The PCM16 WAV reader accepts observed unknown-size data declarations
`0x7fffffff` and `0xffffffff` using actual remaining bytes. Ordinary declared
lengths still require complete data; empty or silent samples remain invalid.

## Success evidence

Use a completed Provider terminal state, real response content, completed SSE, a validated media artifact, or a completed asynchronous video job as appropriate. A 200 status, SSE Content-Type, open route, empty result collection, or unsuccessful terminal state **alone** is not a completed task. The Codex realtime test calls the issued client base `/backend-api/codex/realtime/calls` and must receive an SDP answer, the caller's transcript, and output audio packets. A non-404 response is not that session. Codex Responses live proof uses canonical `POST /backend-api/codex/responses`, with one legacy `POST /v1/responses` stream as compatibility for the same operation. Deterministic tests own the exact alias. This suite does not establish ChatGPT Realtime WebSocket, subscription speech, or a paid Live session unless that job is actually run.

External-client tests use isolated synthetic HOME directories with real scoped API keys; CI operator credentials must not be inherited by the installer process. Tests that create external resources must clean their own IDs in failure paths where the Provider API supports it.

Codex compaction must produce a nonempty opaque item and complete a subsequent
request that uses it to recover prior synthetic context. Accept either
`response.output_item.done` or the final response output as the item carrier;
trigger and completion event names alone are insufficient. Keep the item and
continuation output in memory and use secret-safe failure assertions.

xAI compact proof keeps the complete returned output array unchanged and appends
one question that does not repeat the synthetic fact. The continuation must
complete and recover that fact. HTTP and WebSocket speech proof requires actual
audio samples and the known spoken fixture's transcript, not just an open route
or a completion event. STT requires `transcript.done` plus a known-phrase match
in its terminal text or one individual locked `transcript.partial` with boolean
`is_final=true`. Unlocked text and phrases assembled from separate partials do
not establish the result. The provider's [STT event contract](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
defines locked chunks separately from completion. WebSocket Responses requires generated text and a
successful terminal state; Voice requires audio, its assistant transcript and
completion. Chunk counts and chunk boundaries do not decide success.

Failure assertions expose only safe scalar/boolean projections or fixed errors,
not whole provider/client bodies. Credits cleanup attempts every owned key and
personal policy removal, confirms their effects, and preserves both task and
cleanup failures. The created test user, revoked-key records and usage/audit
history remain as metadata; there is no user-deletion endpoint in this workflow.

The Codex CLI gate uses the unchanged official non-interactive installer with its
supported GitHub Releases source in an isolated HOME. Native curl controls own
connection and transfer stalls: 10-second connection establishment, and 60 seconds
below 1 byte/s. There is no installation wall-clock deadline. CLI execution retains
its separate limit; the CI Job still has its declared overall cancellation bound.

## Coverage limits

This suite still does **not** establish successful xAI Batch submission/results/cancel, deferred Chat completion retrieval, Documents Search, or creation of realtime client secrets. Those shared-authority workflows require explicit valid fixtures and honest independent outcome oracles before being counted as covered. Deployed Feishu login and production MCP authorization are separate release acceptance boundaries.

See [surfaces](../../docs/product/surfaces.md) for the exact Plan allowlists and [verification gates](../../docs/develop/gates.md) for the L2/L3 evidence boundary. No executed Live history or key availability is inferred from this source tree.
