# Agency Relay

Language for request admission, provider outcomes and recorded usage.

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
