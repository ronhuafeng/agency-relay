# Agency Relay

Agency Relay is a Cloudflare Worker AI relay and organization console for Codex, Grok, and explicitly delegated xAI API access. It owns access, credentials, admission, and narrow compatibility boundaries; clients and providers own their application semantics.

## Organization access

The accepted product design is an email-first, single-organization console:

```text
Browser -> Feishu -> organization mailbox -> host-only session -> Agency Relay user/admin role
   user -> own keys, usage, quota, and setup
   admin -> people, roles, quotas, credentials, and audit

Client -> Agency Relay API key -> active user + exact surface grant
       -> effective allowance + sticky credential binding
       -> exact Execution Plan -> provider/backend
```

Feishu authenticates the browser. Agency Relay resolves the normalized organization mailbox to a stable internal `user.id`, then enforces the current D1 role and account status. A mailbox is not administrator authority. Feishu `open_id` is not an account key. Client API keys remain separate from browser sessions.

**Implementation status:** these pages are the accepted contract, not a production cutover record. Source and the release issue own what is deployed.

Start with the [organization access contract](docs/product/organization-access.md) and the [release and cutover runbook](docs/operate/release.md). GitHub Issues own implementation progress; source and deployed evidence own actual behavior.

## Proxy boundary

Exact hostname, method, and path select an immutable Execution Plan. Codex reaches the ChatGPT Codex backend through the egress shim where declared by its plan. Grok and xAI use their exact plan-owned origins and credential slots. No client-selected upstream, arbitrary route fallback, or general provider-dialect converter is introduced by organization access.

The explicit xAI surface carries shared provider-team authority. It does not isolate provider resources per relay user. An organization administrator must understand that distinction before granting positive xAI allowance. See [surfaces](docs/product/surfaces.md).

## Development

```bash
pnpm install --frozen-lockfile
```

Use the [local console preview](docs/develop/console-preview.md) for frontend development and design review. Native commands are declared in [package.json](package.json); select checks through the risk-based [verification ladder](docs/develop/gates.md). Documentation-only changes do not justify provider calls or deployment.

Frontend style-system architecture and rationale live in the [Design System Governance Loop](docs/develop/design-system.md).

Operator credentials belong in ignored project-root `.env`; local Worker secrets belong in ignored `.dev.vars`. Never commit either or copy production secrets into local fixtures.

[Documentation map](docs/README.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

Grok/Harness product architecture, source, Stories, CI, and releases remain owned by `Harness-X-Harness/codex`.
