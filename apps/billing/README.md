# Billing

Owns payment/refund truth, attempts/logs, refundable budgets, cancellation/no-charge tombstones and provider reconciliation. Exchanges durable commands/results with Commerce; never writes Commerce tables.

Private migrations now define payments, refund obligations/allocations/logs, attempts, cancellation tombstones and outbox/receipts. Exact numeric/IRR, immutable identity/terminal results and a serialized captured-refund budget are enforced in SQL. Runtime cannot mutate migration history or append-only logs.

`main.ts` currently exposes health and the protected internal identity diagnostic; charge/refund processing is later. Future feature modules belong under `src/modules/`. Service credentials are owner-scoped; provider calls must not run inside SQL transactions.
