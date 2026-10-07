# Design System Governance Loop

## Authority and status

This document owns Agency Relay's design-system architecture and rationale.
[Console design](../../design.md) owns visual guidance,
[Product experience](../product/experience.md) owns task meanings, and
[Verification gates](gates.md#design-system-local-preflight-and-ci) owns evidence.

The target is deliberately small:

~~~text
DTCG 2025.10
  ├─ community compiler → runtime theme
  └─ projection         → design.md

runtime theme → Agency Relay-owned shadcn/Radix primitives → compositions → pages
~~~

DTCG is the machine source of truth. Terrazzo compiles it into the runtime theme.
The repository path `design.md` is the single agent-facing design
contract. “DESIGN.md” elsewhere refers to the external format/specification, not
a second file; do not create an uppercase duplicate.

`pnpm run console:build` and `pnpm run console:check` generate the shared runtime
theme and the `design.md` token frontmatter from `tokens/console.resolver.json`.

## Why

Agency Relay already has a deliberate visual language. The problem is ownership drift:
exact values, component defaults and page overrides can change independently.

Use existing standards instead of creating a private token schema, resolver,
compiler or design platform. Generated artifacts are projections, not editable
authorities. Do not infer a rendered defect from a class name, stylesheet size or
first declaration; inspect the real cascade and geometry.

## Token boundary

Tokenize reusable design decisions: semantic colors, typography, shared
spacing/radius, repeated shadows and stable shared control geometry.

Keep content-driven breakpoints, grid tracks, chart coordinates, percentages and
measured runtime geometry with their owning implementation.

Start with the smallest real token set. Do not pre-build a multi-brand hierarchy or
split tokens into layers without consumers. Light and dark resolve the same
semantic roles; use standard Resolver support when it is natural in the pinned
compiler rather than inventing local theme machinery.

## design.md projection

Exact supported token values in `design.md` come from canonical DTCG; prose remains
human-reviewed guidance.

Prefer maintained community conversion tooling. If the ecosystem cannot produce
Agency Relay's useful projection, a thin replaceable formatter may serialize
already-resolved data. It must not become another schema, resolver or build system.

Validate the produced document with pinned `@google/design.md` tooling. There is no
lossless DTCG↔DESIGN.md round-trip requirement and no need to wait for evolving
upstream import/theme capabilities.

## UI ownership

Local `src/admin/ui/components` code is Agency Relay-owned. shadcn/Radix supplies useful
anatomy and interaction behavior; its default theme is not Agency Relay's visual authority.
Normalize imported primitives to canonical tokens and selectively port upstream
interaction/accessibility fixes.

Primitives own appearance, state and interaction contracts. Extract a composition
only after at least two real tasks share the same layout/interaction problem. Pages
bind business data and operations and may own genuinely unique layout; they do not
redefine semantic tokens or reach into primitive internals to repair appearance.

Preserve product contracts rather than DOM/class snapshots: exact URLs and return
targets, authority, state distinctions, native forms, one-time secrets, mutation
outcomes, focus and recovery remain intact.

## Source policy

Checks cover only the common supported authoring paths:

- design-bearing CSS values use canonical tokens;
- authored code does not redefine the generated semantic-token namespace;
- ordinary business/page TSX does not hand-author visual `style` values;
- Tailwind/CVA does not use literal arbitrary visual values to bypass the token theme;
- generated runtime/design artifacts are fresh.

Use existing Stylelint/ESLint/Tailwind-capable rules before custom code. Add a rule
only when a real supported path demonstrates the need. Do not turn design
governance into a JavaScript security analyzer, bypass-fuzzing suite or runtime
DOM/CSS monitor.

## Runtime geometry

The invariant is **no unowned design decision**, not zero `style` attributes.

Radix positioning, measured geometry, SVG/chart coordinates and progress transforms
may depend on runtime data. Keep them in the precise owner. Fixed reusable visual
decisions belong in tokens.

The existing nonce-bound SSR stylesheet transport may carry generated token-driven
CSS. It is transport, not another style authority. CSP remains a security boundary,
not the design-token checker.

## Local preflight and CI

[Verification gates](gates.md#design-system-local-preflight-and-ci) owns the
native commands, failure rules and CI signal for this boundary.

## Evolution

A replacement must identify a current unmet need, prefer upstream/community
capability, preserve one-way ownership and update this authority. Optional design
or agent tools may consume the system, but they do not become canonical sources or
required CI without a real consumer.

GitHub issues own implementation progress. Do not keep an implementation roadmap
or historical decision log in this document.
