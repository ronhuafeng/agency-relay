# Live validation

All files under this directory use actual Agency Relay API keys and deployed Provider/Worker endpoints. They **must not** fall back to mocks or interpret a Provider-side failure as task completion.

## Selection and ownership

`.github/workflows/live.yml` is the single entry point:

| Selection | Evidence |
| --- | --- |
| `all` | Every current `tests/live/**/*.test.ts` test (including production media and external CLIs); scheduled default |
| `core` | Health plus successful Codex, Grok and xAI text/Responses paths; **not** all product capabilities |
| `codex`, `grok`, `xai` | Every Live capability owned by that surface's directory |
| `images`, `videos`, `files` | Both Grok and xAI real task/media/file lifecycle tests |
| `clients` | Real Codex and Grok installed CLIs, including Grok text/image/video |
| `access` | Real cross-surface rejection and undeclared-path/method denial |
| `credits`, `billing` | Deployed admission state and route-qualified metering |
| `xai-resources` | xAI stored Response retrieval/deletion and shared resource list reads only |

Provider suite directories are organizational boundaries; an `images` selection covers **both** image directories. A green narrower selection says nothing about excluded providers or capabilities.

## Success evidence

Use a completed Provider terminal state, real response content, completed SSE, a validated media artifact, or a completed asynchronous video job as appropriate. A 200 status, SSE Content-Type, open route, empty result collection, or unsuccessful terminal state **alone** is not a completed task. Codex Realtime route compatibility probes are explicitly *reachability* checks; do not treat them as successful speech sessions.

External-client tests use isolated synthetic HOME directories with real scoped API keys; CI operator credentials must not be inherited by the installer process. Tests that create external resources must clean their own IDs in failure paths where the Provider API supports it.

## Coverage limits

This suite still does **not** establish successful xAI Batch submission/results/cancel, deferred Chat completion retrieval, public file URLs, Documents Search, or creation of realtime client secrets. Those shared-authority workflows require explicit valid fixtures and honest independent outcome oracles before being counted as covered. Deployed Feishu login and production MCP authorization are separate release acceptance boundaries.

See [surfaces](../../docs/product/surfaces.md) for the exact Plan allowlists and [verification gates](../../docs/develop/gates.md) for the L2/L3 evidence boundary. No executed Live history or key availability is inferred from this source tree.
