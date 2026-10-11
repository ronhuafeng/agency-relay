# Agency Relay North Star

## Product goal

An authorized organization member can sign in with their verified organization email, manage only their own client access, and use native clients through Agency Relay. An organization administrator can govern people, roles, allowances, and upstream credentials without distributing infrastructure secrets.

For every admitted request matching one exact Execution Plan, Agency Relay delivers a request that is native-equivalent at the selected provider/backend contract boundary. Native-equivalent means protocol compatibility there; it does not prove which client binary created a request or promise forensic equivalence of network, TLS, connection, or credential identity.

> Agency Relay owns authority. Clients and providers own their semantics. The Execution Plan owns Agency Relay compatibility behavior.

The [organization access contract](organization-access.md) owns identity and control-plane policy. Current source and bounded runtime evidence establish implementation and deployment; this document is not a release record.

## Two authority paths

The browser control plane is:

```text
Feishu organization login
 -> host-only console session
 -> normalized email
 -> stable Agency Relay user + current role/status
 -> self-service ownership or administrator authorization
 -> bounded, audited control-plane operation
```

The client data plane is:

```text
Agency Relay API key
 -> active key and active user
 -> exact host/surface grant and Execution Plan
 -> current surface entitlement and atomic credit admission
 -> stored key/surface credential binding and fresh TokenAuthority
 -> header isolation and plan-owned compatibility projection
 -> one provider attempt
 -> non-interfering metadata observation
```

The diagram names required gates, not a mandate to reorder unrelated transport internals. All required authorization and admission must complete before provider dispatch. Browser login, API-key possession, application role, quota, and upstream readiness remain distinct facts.

A Runtime MCP client is a separate admission path. It presents a resource-bound OAuth bearer decided by one Agency Relay grant authority. Provider Execution Plans remain the client data plane above. The target resource and grant rules live in [surfaces](surfaces.md).

## Organization boundary

V1 serves one organization, potentially with more than one explicitly authorized email domain. It does not build multi-tenant memberships, organizations, billing plans, or cross-tenant administration. Keep stable identifiers and narrow policy seams so future multi-tenancy is possible without claiming it already exists.

Verified email is the sole application login identity. D1 owns `admin`/`user` roles, account lifecycle, organization credit defaults, and personal overrides. A Feishu login does not confer application administrator status. Client keys never acquire administrator privileges from their owner's role.

A normal user sees only their own console data and never chooses or sees internal credential accounts. An administrator has organization-wide control-plane authority. The xAI data plane is a separately documented high-authority exception: granting it delegates the bound provider team's capabilities; `/me` isolation does not make that provider surface owner-isolated.

## Closed-world proxy boundary

Only declared Execution Plans are accepted. Similar hosts, paths, headers, bodies, and client versions never infer routing, scopes, credentials, or fallbacks. Key creation resolves defaults once; requests use stored bindings, not the latest account or organization default.

Agency Relay removes caller credentials, account fields, and hop-specific headers before egress. It applies only the compatibility metadata owned by a plan. Upstream client identity is never authentication or authority.

Request bodies and WebSocket frames stay opaque unless a current, exact Agency Relay ownership or measurement contract requires a bounded observation. Agency Relay does not repair payloads, infer models/tools/parameters, invent provider capabilities, or rebuild a provider catalog.

Preserve provider status, application semantics, encoding, streaming, and bytes outside explicit plan-owned safety rules. An observation failure cannot replace an otherwise successful client response.

## Responsibilities

Agency Relay owns console session verification, email resolution, JIT provisioning, RBAC, object ownership, key lifecycle, surface admission, sticky bindings, credential refresh, header isolation, exact route selection, contained transport, declared resource-ownership checks, metadata accounting, and secret-free control-plane audit.

Agency Relay does not own organization HR/IdP lifecycle automation in V1, provider subscription rights, settlement/invoicing, arbitrary dialect conversion, official-client provenance, Codex sessions/tools/history/UI, Grok/Harness product semantics, or another repository's branches, CI, Stories, or releases.

Offboarding requires an Agency Relay disable operation as well as upstream identity-provider removal. An 8-hour browser session is not an API-key revocation mechanism.

## Extension rule

For a control-plane change, identify the principal, authorized operation, affected object, atomic invariant, and observable result. For a proxy change, identify the exact plan, the current Agency Relay-owned contract, and why the client or provider cannot own the behavior instead.

Preserve unrelated behavior. Prove the change at the smallest owning boundary. Operational release and rollback are governed by [release.md](../operate/release.md), not by a documentation merge.
