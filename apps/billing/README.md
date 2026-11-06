# Billing

Owns payment/refund truth, attempts/logs, refundable budgets, cancellation/no-charge tombstones and provider reconciliation. Exchanges durable commands/results with Commerce; never writes Commerce tables.

`src/main.ts` currently provides boot/health. The private Prisma configuration/schema is ready for the next database milestone. Future feature modules belong under `src/modules/`; provider calls must not run inside SQL transactions. No charge/refund endpoint is exposed by this skeleton.
