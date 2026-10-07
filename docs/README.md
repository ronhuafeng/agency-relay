# Documentation

This is the sole documentation map. Documentation owns accepted contracts; current source and deployment evidence establish what is implemented. GitHub Issues own implementation progress, not a parallel Markdown roadmap.

Use the row that matches the changed boundary. The product-design-loop owns the reusable procedure for resolving a task's execution environment and evidence; this map and current source own Agency Relay-specific answers. Frontend work starts with Console design and the local preview workflow; token, CSS, primitive or style-ownership changes also use the Design System Governance Loop. Read Product experience when action meanings or recovery change. Policy and reporting changes use their domain contract. A document is not a deployment or migration record. A Feishu mailbox alone never grants administrator authority.

| Question | Authority |
| --- | --- |
| What does Agency Relay own? | [Product North Star](product/north-star.md) |
| Email identity, JIT, roles, ownership and key policy | [Organization access contract](product/organization-access.md) |
| Member/admin journeys and safe actions | [Product experience](product/experience.md) |
| Design-token authority, runtime generation, source policy and architectural rationale | [Design System Governance Loop](develop/design-system.md) |
| Agent-facing design context: reviewed visual/interaction guidance plus generated design-token projection | [Console design](../design.md) |
| Project-agnostic procedure for resolving UI execution context, evidence-driven design/repair and proposed process improvements | [Product design loop](../.agents/skills/product-design-loop/SKILL.md) |
| Hosts, grants, exact provider authority and xAI risk | [Product surfaces](product/surfaces.md) |
| Executable route registration | [`src/plans/execution-plans.ts`](../src/plans/execution-plans.ts) |
| Frontend debug/review workflow, local scenarios and private metadata snapshots | [Console preview](develop/console-preview.md) |
| Native tests, local pre-commit checks, Actions gates, concurrency and evidence | [Verification ladder](develop/gates.md) |
| Responses and egress compatibility | [Responses development](develop/responses.md) |
| Release, preparation, cutover and rollback | [Release operations](operate/release.md) |
| Bootstrap, upstream credentials, defaults and sticky bindings | [Credential operations](operate/credentials.md) |
| Default/override quotas and admission | [Credit operations](operate/credits.md) |
| Personal/admin reporting and measurement coverage | [Usage](operate/usage.md) |
| Authorization/admission versus transport failure | [Diagnosis](operate/debug-transport.md) |
| Issues, publication and dependency conventions | [GitHub tracker](agents/issue-tracker.md) |
| Existing triage vocabulary | [Triage labels](agents/triage-labels.md) |
| Secret handling and security boundaries | [Security policy](../SECURITY.md) |

Root entrypoints are [README](../README.md), [AGENTS](../AGENTS.md) and [CONTRIBUTING](../CONTRIBUTING.md). Live Agency Relay evidence is owned by [`tests/live/`](../tests/live/) and the release issue, not another product's CI or Stories.

Engineering documentation is **English**, one language per file. Keep current contracts concise and linked; do not add duplicate indexes, design histories or migration journals.
