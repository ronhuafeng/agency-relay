# Issue tracker: GitHub

GitHub Issues in `ronhuafeng/agency-relay` are the sole implementation and PRD tracker. Use the authenticated GitHub connector or the native `gh` interface, as available and requested. Verify repository identity before writing; do not route Agency Relay work to an unrelated connected tracker.

## Evidence-backed planning

Read repository instructions, the owning accepted contract, current default-branch source/tests/schema and existing open issues/PRs. Name the inspected revision. Prior chat analysis is candidate input, not proof of present implementation.

For each candidate, establish goal -> observed behavior -> verified gap/unknown -> independently acceptable outcome -> evidence/dependency. Remove resolved work, reuse an issue that already owns the same outcome, and do not publish a claim whose authority cannot be inspected. Keep uncertain production configuration as an operator verification item rather than invented code facts.

One issue owns one independently closable result. Merge work that has no useful separate acceptance boundary; split by independent outcomes or release responsibility, not mechanically by file. An umbrella is justified only by a real tracking consumer, such as the operator accepting a coordinated cutover.

Each issue needs an outcome title, baseline evidence, consequence, bounded scope, objective acceptance criteria and real blockers. Include implementation suggestions only where they clarify a known seam; semantics are the contract. Use [the canonical triage vocabulary](triage-labels.md), not invented priority/label systems.

## Publication and relationships

Publish only on explicit issue-creation authorization. Recheck duplicates and the finalized dependency assumptions before the first issue write. Treat each creation as one effect and record the returned issue identity. If a result is uncertain, reconcile through tracker readback before repeating it.

Use native blocking relationships when the available interface supports them. Otherwise put `Blocked by: #...` in the dependent issue body after the blocker identity is known. Do not claim a native dependency exists when only a body reference was added. A related issue is not automatically a blocker.

Read back every created/updated issue, including labels and body. Report created/reused identities, dependency order and failures truthfully. Close only with completion evidence or an explicit terminal triage state. PR creation/merge, code changes and deployments are separate effects requiring their own task authority; issue publication alone authorizes none of them.

## Source of truth and drafts

Product documentation owns accepted current contracts, source/tests own implementation facts, and release evidence owns deployed status. Do not present a target document as implementation completion or duplicate issue bodies into a permanent repository roadmap.

Local `.scratch/<feature>/issues/` may hold temporary drafts when needed, not a second tracker. Remove matching drafts after confirmed publication. Read an issue's body, comments and labels before later implementation or triage. Pull requests are not a general triage-request surface.
