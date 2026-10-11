# Live validation

All files under this directory use actual Agency Relay API keys and deployed Provider/Worker endpoints. They **must not** fall back to mocks or interpret a Provider-side failure as task completion.

## Selection and ownership

`.github/workflows/live.yml` is the single entry point. Seven stable, capability-owned Jobs run native Vitest suites. `.github/actions/setup-live/action.yml` only prepares the pinned Node/pnpm environment; it does not select or wrap tests. Jobs run independently where possible; Accounting waits until the other Live Jobs have finished, then records its own result even if another Job failed (but not after cancellation). Provider and authority Jobs use one Vitest file worker at a time; native client tests allow two, avoiding the unbounded concurrency of a file-level matrix:

| Selection | Evidence |
| --- | --- |
| `all` | Every current `tests/live/**/*.test.ts` test (including production media and external CLIs); scheduled default |
| `core` | Health plus successful Codex, Grok and xAI text/Responses paths; **not** all product capabilities |
| `codex`, `grok`, `xai` | Every Live capability owned by that surface's directory |
| `images`, `videos`, `files` | Both Grok and xAI real task/media/file lifecycle tests |
| `clients` | Real Codex and Grok installed CLIs, including Grok text/image/video |
| `access` | Real cross-surface rejection and undeclared-path/method denial |
| `credits`, `billing` | Deployed admission state and route-qualified metering |
| `xai-resources` | xAI stored Response retrieval/deletion, shared list reads, and synthetic-file public URL/revoke lifecycle |

Provider suite directories are organizational boundaries; an `images` selection covers **both** image directories. A green narrower selection says nothing about excluded providers or capabilities.

The Jobs are **Reachability** (smoke), **Codex**, **Grok**, **xAI**, **Clients**, **Authority** (access and credits), and **Accounting** (billing). Each selected `.test.ts` file runs exactly once; missing or failed tests are not converted into a successful gate. The scheduled run still selects `all` and uses real production credentials and providers. When introducing a new root-level Live test, assign it explicitly to the owning Job; tests added under a Provider or client directory are picked up by that directory's full suite.

## Success evidence

Use a completed Provider terminal state, real response content, completed SSE, a validated media artifact, or a completed asynchronous video job as appropriate. A 200 status, SSE Content-Type, open route, empty result collection, or unsuccessful terminal state **alone** is not a completed task. Codex Realtime route compatibility probes are explicitly *reachability* checks; do not treat them as successful speech sessions.

External-client tests use isolated synthetic HOME directories with real scoped API keys; CI operator credentials must not be inherited by the installer process. Tests that create external resources must clean their own IDs in failure paths where the Provider API supports it.

## Coverage limits

This suite still does **not** establish successful xAI Batch submission/results/cancel, deferred Chat completion retrieval, Documents Search, or creation of realtime client secrets. Those shared-authority workflows require explicit valid fixtures and honest independent outcome oracles before being counted as covered. Deployed Feishu login and production MCP authorization are separate release acceptance boundaries.

See [surfaces](../../docs/product/surfaces.md) for the exact Plan allowlists and [verification gates](../../docs/develop/gates.md) for the L2/L3 evidence boundary. No executed Live history or key availability is inferred from this source tree.
