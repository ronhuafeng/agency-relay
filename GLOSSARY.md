# Agency Relay

Language for request admission, provider outcomes, recorded usage and Runtime access.

## Request accounting

**Provider Attempt**:
One Agency Relay-owned attempt under an exact Execution Plan and selected provider authority. Its identity is independent of caller-supplied request correlation.
_Avoid_: User task, provider bill

**Credit Admission**:
The committed authorization to consume an Execution Plan's fixed Surface Credit charge. It is not evidence of provider success or cash expenditure.
_Avoid_: Successful request, token charge

**Opening Credit Balance**:
Previously recorded Surface Credit consumption before a period's first fact-backed admission. It preserves consumption without inventing individual historical admissions.
_Avoid_: Reconstructed history, verified historical bill

**Terminal Confirmation**:
Durable evidence that the same Provider Attempt's terminal accounting committed. Absence means no retained confirmation, not necessarily a running request.
_Avoid_: Completion inferred from time, provider invoice

**Provider Usage Measurement**:
Usage supplied by the provider and captured under the Execution Plan's observation contract. Missing measurement is unknown, not zero.
_Avoid_: Surface Credit, settled charge

## Runtime access

**Runtime Installation**:
A reviewed shared upstream capability with a stable Agency Relay identity and resource URI. Changing its display name does not change its authority.
_Avoid_: Provider account, arbitrary MCP URL

**Installation Access**:
An administrator's explicit permission for one eligible human member to use one Runtime Installation. It does not authorize a client on that member's behalf.
_Avoid_: Provider allowance, client consent

**Client Consent**:
A member's permission for one registered client to use one Runtime Installation within the stated scope and authority. It depends on current Installation Access.
_Avoid_: Browser login, organization membership

**Authority Revision**:
The identity of an installation's current upstream authority. A disable, retirement or upstream authority change invalidates consent tied to an earlier revision.
_Avoid_: Display revision, secret version

**Secret Rotation**:
Replacement of credential material for the same declared upstream authority. It is not evidence that two credentials belong to the same account.
_Avoid_: Account rebind

**Authority Rebind**:
An explicit change to the upstream account or workspace behind an installation. Old Client Consent does not authorize the replacement authority.
_Avoid_: Refresh, secret rotation
