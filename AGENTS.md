# Agent instructions

## Read first

Read [docs/README.md](docs/README.md), the sole documentation map, and select the authority for the changed boundary. Inspect the current source and owning issue before interpreting documentation as an implemented capability. For executable changes also read [verification gates](docs/develop/gates.md). Frontend work uses [Console design](design.md) and the map's local-preview workflow; read the [Design System Governance Loop](docs/develop/design-system.md) when tokens, CSS, primitives or style ownership change. Tests alone do not establish design approval.

For Agency Relay UI/product-design work, use the in-repository
[product-design-loop](.agents/skills/product-design-loop/SKILL.md) skill as the
project-agnostic procedure. Resolve Agency Relay-specific execution answers from this
repository's accepted authorities and current source rather than treating the skill
as another source of stack configuration. For the current web console,
[design.md](design.md) is the single agent-facing design context: its prose owns
reviewed visual/interaction guidance and its generated token frontmatter is a
projection, not a second machine source. The Design System Governance Loop owns
shared style/token architecture and the canonical DTCG source; Console preview owns
the real-UI review path; Verification gates owns proof selection and limits; relevant
product documents keep task, permission, consequence and recovery meaning. Do not
add a parallel product-design configuration or hand-maintained design mirror merely
to restate those facts, and do not project the console's runtime, component system
or evidence tooling onto another surface without that surface's authority.

## Design-system changes

Read [Design System Governance Loop](docs/develop/design-system.md) before frontend
style work. Preserve one-way ownership: DTCG machine source → generated runtime
theme / `design.md` → Agency Relay-owned primitives → task compositions → pages. Do not add
a parallel token/theme authority or private compiler without an explicit reviewed
architecture change.

Run the relevant native local checks before commit/push and fix violations at their
owner. Do not hand-edit generated values, bypass tokens with page styling, or weaken
checks to make an agent proposal green. Preserve narrowly owned runtime geometry;
zero inline styles is not the contract.

## Proxy boundary

Preserve exact proxy contracts. xAI's explicit shared-team authority is not made owner-isolated by console RBAC. Do not add provider routing, automatic credential failover, generic protocol conversion, or multi-tenancy to satisfy a control-plane ticket.

## Repository boundaries

This repository owns Agency Relay. External Codex/Grok clients may be used to prove a specific Agency Relay contract, not the correctness of those products. Grok Provider and Harness Goal/Workflow implementation, Stories, source, branches, CI and releases belong to `Harness-X-Harness/codex`.

GitHub Issues in this repository own implementation/PRD tracking. Avoid duplicate roadmap files, migration journals, current-version ledgers or issue mirrors. History belongs in Git history. Documentation owns current accepted contracts; source and bounded deployment evidence own actual behavior.

## Verification and effects

Prefer native TypeScript, Vitest, Wrangler and egress checkers. Do not add wrappers that merely dispatch/parse/aggregate other native runners. Do not make Markdown headings, keywords or inventories executable product acceptance inputs.

Use semantic tests of the owning boundary. Database invariants need real SQL behavior; a mock's recorded call count cannot prove atomic authorization or rollback. Do not assume a zero-row conditional write rolls back a whole batch or that D1 and TokenAuthority share a transaction.

For authorized external writes, confirm effects through authoritative readback. Do not repeat a creation with unknown result before reconciling it. Do not widen Access, mutate production data or deploy as an incidental side effect of documentation/issue work.

Never record secrets, raw traffic, prompts or response bodies in docs, issues, logs, screenshots or test artifacts.
