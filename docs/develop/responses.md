# Responses and adapter development

Use this page for Responses adapters, model discovery, egress, transport probes and Worker releases. Organization console work is governed by [organization-access.md](../product/organization-access.md); it must preserve the proxy boundaries below.

## Ownership

Agency Relay owns authentication, exact grants/plans, current surface admission, stored credential bindings/slots, secret/header isolation, declared compatibility metadata, metadata accounting, redirect containment and cancellation propagation. Providers own payload validity, model semantics, accepted error bodies and their protocol behavior. External clients own their sessions, tools, compaction and UI.

The organization redesign separates browser email principals from client API keys. Do not make a proxy client perform Feishu login, infer grants from an admin role, choose today's default credential at request time, or skip disabled-surface checks because a plan has zero charge.

Bodies and WebSocket frames remain opaque outside exact owned contracts. No general parse, repair, conversion, fallback provider or payload-based route inference belongs in this work.

## Plan-declared metering

Each exact Execution Plan selects `responses`, `image`, `video` or `none`. Neither hostname nor the console's reporting needs can infer an observer.

The client-facing path preserves status, provider headers, encoding and bytes. For an exact HTTP 200 Responses request already classified as SSE by the caller's exact `Accept: text/event-stream`, Agency Relay may complete a missing Content-Type with `text/event-stream` only under the existing plan-owned policy. It never overwrites a provider header or applies this to an error response. Codex owns this in its adapter; the exact Grok/xAI Responses plans declare their equivalent policy.

A bounded observer may consume only proven terminal metadata. It follows the client stream, stops on cancellation and must not keep draining upstream only for accounting. A failure cannot replace an otherwise successful client result. Do not make canonical control-plane mutation audit a new blocking dependency of provider-response observation.

Unary Responses usage requires complete receipt; SSE usage comes from a supported terminal event. Decode supported compression only where observation requires it without changing client bytes. Retain valid provider cost ticks exactly. Missing, malformed, partial, over-limit, cancelled or unsupported observation stays unknown, not zero. Image/video use the media ledger rather than zero-token Responses rows.

Credit admission is separate: an admitted charge is not computed from those observations or refunded based on guessed provider billing. See [credits](../operate/credits.md) and [usage](../operate/usage.md).

## Evidence and release

Before asserting wire compatibility, connect producer, wire type, ownership, consumer and behavioral test. A provider possibly accepting a payload is not evidence that a supported client sends it. Exact source plan registration remains authoritative; new capabilities require their own contract.

Use [gates.md](gates.md): relevant L0/L1 before submission, L2 for a changed deployed boundary, and the bounded semantic/release evidence required by [release.md](../operate/release.md). Do not run paid live calls for documentation-only work.

Keep `global_fetch_strictly_public` for same-zone egress. Worker upload and deployment use the same computed Git SHA and exact `release $GIT_SHA` annotation. An organization control-plane release does not authorize an egress topology change.
