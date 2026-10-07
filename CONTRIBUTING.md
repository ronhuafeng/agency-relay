# Contributing

## Start with the owned contract

Start with [the documentation map](docs/README.md), the current source and the issue owning the requested outcome. Read the contract for the changed boundary. Presentation changes use its design entry; token, CSS, primitive or style-ownership changes also use the [Design System Governance Loop](docs/develop/design-system.md). Changes to actions, authority, allowance, credentials or reporting use their owning contracts.

The accepted design is not automatically deployed behavior. Describe the observed baseline, intended semantic change and release boundary in the PR. Do not turn a documentation update into an unreviewed authentication, quota or production-policy cutover.

## Development and verification

```bash
pnpm install --frozen-lockfile
```

Use the native commands in `package.json` and [the verification ladder](docs/develop/gates.md). For changed Worker behavior, run the owning static checks and focused Vitest contracts. Exercise D1 concurrency/invariants through SQL-backed tests. Egress behavior uses the owning egress checker/tests. Provider live calls are not a default requirement for local RBAC, email, key or CSRF tests.

For documentation-only changes, review semantic consistency, links and GitHub diff scope. Do not introduce tests that assert Markdown headings or wording. Do not claim unrun tests passed.

## Design changes and local preflight

Follow the [Design System Governance Loop](docs/develop/design-system.md): edit the
canonical owner, regenerate derived runtime/DESIGN.md artifacts, run the relevant
native checks locally, and review the real affected task. Pages do not create a
second visual authority or repair primitive styling through ad hoc overrides.

GitHub Actions reruns the deterministic checks on the actual revision. On the
current GitHub Free private repository, maintainers enforce the no-merge rule for
failed, missing or unresolved applicable CI; paid branch protection is not a
project prerequisite. A green gate does not itself approve a design.

## Contribution boundaries

Keep email identity, application authorization, client-key scope, allowance admission, upstream credentials and provider semantics distinct. A member cannot choose an upstream account, `/me` cannot become global for admins, and role changes cannot silently expand key grants.

Preserve native-equivalent proxy behavior outside explicit plan-owned rules. Responses/egress changes follow [Responses development](docs/develop/responses.md). Organization changes follow the additive preparation and coordinated cutover in [release.md](docs/operate/release.md).

Use GitHub Issues as the sole tracker; each issue should own an independently acceptable outcome and cite current evidence. Dependencies must be real blockers, not an arbitrary serial task list. Follow [tracker conventions](docs/agents/issue-tracker.md).

Never commit `.env`, `.dev.vars`, auth files, private keys, provider payloads or generated secrets. Follow [SECURITY.md](SECURITY.md) and the existing artifact scan for code/artifact work.

For frontend changes, use the [local preview workflow](docs/develop/console-preview.md#frontend-debug-and-review-workflow) to review real pages, copy, controls and state transitions. Review the candidate against the design contract; passing tests do not establish design approval. Use synthetic scenarios for shared evidence and keep private snapshot review local.

Select the owning automated checks through [verification gates](docs/develop/gates.md#local-console-browser-regression). Add a focused user-visible regression when behavior changes. Local browser evidence does not replace SQL policy coverage, live Feishu evidence or physical-device acceptance. Never enable trace/DOM recording for key or session scenarios, even with synthetic local authority.
