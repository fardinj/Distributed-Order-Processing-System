# Commerce

Step 6 adds `modules/orders/actions.controller.ts` for owner cancellation, guarded audited retry cycles, attempt history and admin review inspection. Recovery checkpoints/Redis overlap are in `modules/fulfillment/fulfillment.service.ts`; SQL storage admission remains in checkout. Public catalog reads use an optional two-second Redis cache; admin/checkout truth stays in PostgreSQL. See [recovery contracts](../../docs/CANCELLATION_RECOVERY_AND_REDIS.md).

Owns orders, checkout revisions, catalog, stock/reservations, local fulfillment, item dispositions and order history. Digital/subscription/physical processors are separate modules in this service, sharing its short SQL transaction boundary.

`src/modules/catalog` implements protected catalog/admin mutations, audit/idempotency and guarded stock reconciliation. `src/modules/orders` supplies atomic admission/checkout, current-status replay, expiry/reacquisition/revision confirmation and protected reads. `src/worker.ts` schedules bounded expiry and owner-local outbox/inbox preparation. `src/database.ts` manages the owner Prisma/pg pool; `database-errors.ts` maps persistence conflicts safely. Fulfillment execution is implemented in step 5. See [checkout contracts](../../docs/CHECKOUT_AND_OUTBOX.md).

`prisma/` contains the owned model and forward SQL migrations, including unconstrained monetary fields, partial indexes, append-only runtime privileges and immutable snapshots. Never use another owner's client or edit applied migration files. Runtime receives its DB credentials, never the migrator password. Total pool budget reserves one health connection; other slots belong to Prisma.

Step 4 adds atomic `POST /orders/:id/payment` entry and `modules/orders/payment-results.ts`. Payment entry promotes/reacquires holds and commits a stable command; versioned Billing results allocate/release stock and schedule one local fulfillment job per payable item. UNKNOWN retains stock/admission. Charged cancellation suppresses ready work and awaits later refund settlement. Step 5 executes those jobs with transactional effect evidence. See [payment recovery](../../docs/PAYMENTS_AND_BANK_RECOVERY.md).

`src/modules/fulfillment` owns typed processors, bounded SQL work/retries, aggregate settlement, confirmed refund projection/log reads and the audited whole-line shortage action. Database guards preserve first-start cutoff and effect/refund mutual exclusion. Completed/refund-settled work releases admission once; unknown/review debt remains counted. See [fulfillment contracts](../../docs/FULFILLMENT_AND_REFUNDS.md).
