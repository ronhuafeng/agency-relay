# Transport and admission diagnosis

Use read-only, secret-safe evidence to locate the failed boundary. A denied user, exhausted allowance or missing sticky binding is not a provider transport outage. The target organization policy is in [organization-access.md](../product/organization-access.md); actual deployed behavior must be identified before debugging it.

## Establish the last proven gate

Distinguish console session authentication, email-to-user resolution, current role/status, API-key validity, exact grant/plan, effective allowance, stored credential binding, token refresh, provider dispatch and terminal observation. An API key does not need an interactive browser session. A current organization default does not repair an older sticky binding.

For an ordinary member, expose only their own service/key state and sanitized recovery. Internal account IDs, provider-team inventories and global logs are administrator/operator diagnostics.

## Codex 502 and transport

Check Worker `codex_upstream_transport_error` and sanitized error name/message; determine whether upstream status is absent. Confirm whether the bound account's `getFreshAccessToken` succeeded before classifying credential versus transport failure.

Check public egress `/healthz`, shim/cloudflared service health and `egress_request_accepted` in the relevant window. Correlate Worker `worker_request_outcome` with egress outcome using the transport trace ID when available. Keep `global_fetch_strictly_public` enabled for Worker calls to the same-zone tunnel hostname.

Do not blame the ChatGPT account when the egress never accepted the request. Health proves reachability, not a completed model task. Current egress infrastructure and rollback are owned by [release.md](release.md).

## Grok and xAI

Grok Models/Responses use the official CLI gateway; direct-task and explicit xAI plans use their exact declared origins. `provider_upstream_transport_error` indicates a fetch failure. An account in `reauth_required` may fail before any fetch, so correlate the selected stored credential rather than only the latest default.

Existing `provider_attempt_timing` exposes metadata-only `auth_ms`, `credential_slot_ms`, `credit_admission_ms`, `request_to_admission_ms`, `provider_headers_ms` and `request_to_upstream_headers_ms`. A fully drained SSE Responses request can also report first-event timing, stream duration, byte count and chunk count. Null measurement means unobserved, not zero latency.

Quota-denied requests must not appear as successful provider attempts. Provider metering observer failure must not be recast as a failed client response. xAI shared-team authority and opaque WebSockets limit what Agency Relay can prove about provider resources or ongoing sessions; do not infer owner isolation from a personal console page.

## Local terminal evidence

A Codex rollout is the authority for a terminal error it already persisted. With the exact local home and session, this is read-only:

```bash
CODEX_HOME=/absolute/path/to/codex-home \
session-management rollout <SESSION_ID> --include-archived \
| jq -c '
  select(
    .type == "event_msg"
    and .payload.type == "task_complete"
    and .payload.error != null
  )
  | {
      timestamp,
      turn_id: .payload.turn_id,
      error: .payload.error
    }
'
```

This preserves recorded terminal error semantics, not transient events that were never persisted. Provider-supplied error text may be sensitive; review before sharing. Do not make availability of this external client tool an Agency Relay acceptance requirement.

## Stop and evidence rules

Record the last proven stage and mark inconclusive root causes honestly. A timeout only proves that the desired result was not established inside the bounded experiment. Do not repeat paid/state-changing probes to manufacture success or change provider credentials on speculation.

Logs, issues and screenshots remain metadata-only: no bodies, tokens, secret-bearing headers, raw provider IDs/URLs, or key hashes. Use [the verification ladder](../develop/gates.md) for the smallest further proof and [SECURITY.md](../../SECURITY.md) for disclosure hygiene.

## Retained request drilldown

Administrators can open Activity → Request records, filter by UTC dates, exact
plan, current email or stored user ID, Agency Relay result and safe request correlation,
then open a specific internal audit ID. Correlation IDs are caller-provided and
can repeat; they do not identify one record. Pagination orders by recorded time
and internal ID. Detail and return links retain the filter and page context.

This is a read-only projection of existing `request_audit` rows. Its explicit SQL
allowlist reads internal audit/request/user/key/credential IDs, the stored plan
and canonical path, outcome/error/HTTP status, recorded total duration, token
counts, provider cost ticks and timestamp. Current user email and key name are
left-joined labels, visibly marked as current; deleted objects retain the stored
IDs. Method is not stored: the separately labeled current plan-catalog method is
not historical evidence. Unknown or unsafe identifiers, noncanonical paths and
unrecognized error text are not exposed. Provider response/resource IDs,
session/thread values, raw traffic, token/key hashes and live authority are not
selected. No export or additional collection is introduced.

The current write boundary is `commitTerminalOutcome` in
`src/auth/provider-attempt.ts` → `commitProviderAttemptAccounting` / its explicit
insert in `src/db.ts`; schema is migration `0020`. The saved timestamp is the
request start, with total elapsed duration when supplied. Per-phase timing,
terminal-event provenance and observer error detail are logs-only or unavailable
here. A retained row does not prove every intermediate gate. HTTP 200 does not
prove SSE completion, and HTTP 101 does not prove a whole WebSocket session.
Token and amount coverage are independent; missing values stay unknown, while a
saved zero remains measured. Media ledgers cannot be reconstructed per request.

Stable recognized errors offer a read-only current key/person check or this
manual. A current default, scope, allowance or binding never explains historical
admission. Missing rows may be uncollected or removed by existing retention;
read failures are unavailable, not empty success. Daily usage and canonical
management audit remain separate. Do not extend retention or retry paid requests
to make a historical picture look complete.
