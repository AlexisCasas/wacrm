# SYNC-03B — Financial divergence planner

This planner consumes the canonical financial snapshots from WACRM and InkaClick and produces a decision plan only. It never writes to either database.

Rules:

- Different totals => `CONFLICT / REVIEW_REQUIRED`.
- WACRM `not_tracked` + InkaClick tracked => `INKACLICK_AHEAD / IMPORT_REVIEW_REQUIRED`; never invent a WACRM zero payment.
- Same total and greater paid amount on one side, with correspondingly lower balance => that side is ahead.
- Non-monotonic divergence => conflict.
- Missing canonical order on either side => review required.

Possible actions are intentionally non-executing:

- NONE
- EXPORT_FINANCIAL_EVENT
- IMPORT_FINANCIAL_EVENT
- EXPORT_REVIEW_REQUIRED
- IMPORT_REVIEW_REQUIRED
- REVIEW_REQUIRED

SYNC-03C will define the concrete financial event payload. Actual payment application remains disabled until the event contract, correction semantics and real-production reconciliation are validated.
