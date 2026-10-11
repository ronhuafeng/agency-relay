# Live validation

All files under this directory use actual Agency Relay API keys and deployed Provider/Worker endpoints. They **must not** fall back to mocks or interpret a Provider-side failure as task completion.

## Selection and ownership

`.github/workflows/live.yml` is the single entry point. Each current `tests/live/**/*.test.ts` file is one fixed Job. There is no suite input and no matrix. `.github/actions/setup-live/action.yml` only prepares the pinned Node/pnpm environment; it does not select or wrap tests.

`needs` follows a result dependency, not a directory:

- Reachability is `/healthz` on the three production hosts. Every other Job waits for it.
- Codex runs Catalog, then Contract, then Responses. Realtime and the Codex CLI wait for Responses.
- Grok runs Catalog, then Responses. Audio, Files, Images, Videos and the Grok text CLI wait for Responses. The Grok image CLI waits for Images. The Grok video CLI waits for Videos. The video owner check uses the separate `agency-relay-2` Grok key. It does not create a user or use the admin secret.
- xAI runs Catalog, then Responses. Audio, Files, Images, Videos, WebSocket, Resources and Public URL wait for Responses. Responses also receives the Grok surface key because that file checks cross-surface denial.
- Authority · Access waits only for Reachability. Authority · Credits waits only for Reachability; it creates its own user.
- Accounting · Billing waits until every Job that can write the Codex Responses, Grok Responses, Grok Images or Grok Videos ledgers has finished. It still runs when one of those Jobs failed, and it does not run after cancellation. Its own calls must be the only new rows in that window.

A scheduled or manual run starts the whole graph. A failed parent skips its children. Each file runs once. A new Live file needs its own Job and an explicit `needs` edge. Do not add it by widening a directory glob.

## Success evidence

Use a completed Provider terminal state, real response content, completed SSE, a validated media artifact, or a completed asynchronous video job as appropriate. A 200 status, SSE Content-Type, open route, empty result collection, or unsuccessful terminal state **alone** is not a completed task. Codex Realtime route compatibility probes are explicitly *reachability* checks; do not treat them as successful speech sessions.

External-client tests use isolated synthetic HOME directories with real scoped API keys; CI operator credentials must not be inherited by the installer process. Tests that create external resources must clean their own IDs in failure paths where the Provider API supports it.

## Coverage limits

This suite still does **not** establish successful xAI Batch submission/results/cancel, deferred Chat completion retrieval, Documents Search, or creation of realtime client secrets. Those shared-authority workflows require explicit valid fixtures and honest independent outcome oracles before being counted as covered. Deployed Feishu login and production MCP authorization are separate release acceptance boundaries.

See [surfaces](../../docs/product/surfaces.md) for the exact Plan allowlists and [verification gates](../../docs/develop/gates.md) for the L2/L3 evidence boundary. No executed Live history or key availability is inferred from this source tree.
