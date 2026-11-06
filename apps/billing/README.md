# Billing

Owns payment/refund truth, attempts/logs, refundable budgets, cancellation/no-charge tombstones and provider reconciliation. Exchanges durable commands/results with Commerce; never writes Commerce tables.

Private migrations now define payments, refund obligations/allocations/logs, attempts, cancellation tombstones and outbox/receipts. Exact numeric/IRR, immutable identity/terminal results and a serialized captured-refund budget are enforced in SQL. Runtime cannot mutate migration history or append-only logs.

`worker.ts` receives durable checkout preparation plus payment/cancellation commands. `payments.ts` creates immutable payment identities and runs bounded, leased Bank calls/reconciliation outside SQL transactions. Status, attempt history and outbox commit together; UNKNOWN retains increasing due work rather than guessing a decline. No-charge tombstones fence delayed commands; charged cancellation becomes REFUND_REQUIRED. Preparation itself still does not charge. Refund execution is later. `database.ts` shares the bounded owner pool across transport and financial work. See [payment contracts](../../docs/PAYMENTS_AND_BANK_RECOVERY.md).
