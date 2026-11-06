# Billing

Owns payment/refund truth, attempts/logs, refundable budgets, cancellation/no-charge tombstones and provider reconciliation. Exchanges durable commands/results with Commerce; never writes Commerce tables.

Private migrations now define payments, refund obligations/allocations/logs, attempts, cancellation tombstones and outbox/receipts. Exact numeric/IRR, immutable identity/terminal results and a serialized captured-refund budget are enforced in SQL. Runtime cannot mutate migration history or append-only logs.

`main.ts` exposes health and the protected internal identity diagnostic. `worker.ts` receives durable checkout preparation, maintains a versioned local projection, and publishes acknowledgments atomically with receipts. Catalog notifications are observed without financial effects. No preparation creates a payment or calls Bank; charge/refund execution is later. `database.ts` shares the bounded owner pool across transport and domain effects. Future feature modules belong under `src/modules/`; provider calls must not run inside SQL transactions.
