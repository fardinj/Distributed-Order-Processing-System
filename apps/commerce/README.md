# Commerce

Owns orders, checkout revisions, catalog, stock/reservations, local fulfillment, item dispositions and order history. Digital/subscription/physical processors will be separate modules in this service, sharing its short SQL transaction boundary.

`src/modules/catalog` implements protected catalog/admin mutations, audit/idempotency and guarded stock reconciliation. `src/modules/orders` supplies atomic admission/checkout, current-status replay, expiry/reacquisition/revision confirmation and protected reads. `src/worker.ts` schedules bounded expiry and owner-local outbox/inbox preparation. `src/database.ts` manages the owner Prisma/pg pool; `database-errors.ts` maps persistence conflicts safely. Fulfillment execution remains a later milestone. See [checkout contracts](../../docs/CHECKOUT_AND_OUTBOX.md).

`prisma/` contains the owned model and forward SQL migrations, including unconstrained monetary fields, partial indexes, append-only runtime privileges and immutable snapshots. Never use another owner's client or edit applied migration files. Runtime receives its DB credentials, never the migrator password. Total pool budget reserves one health connection; other slots belong to Prisma.

Step 4 adds atomic `POST /orders/:id/payment` entry and `modules/orders/payment-results.ts`. Payment entry promotes/reacquires holds and commits a stable command; versioned Billing results allocate/release stock and schedule one local fulfillment job per payable item. UNKNOWN retains stock/admission. Charged cancellation suppresses ready work and awaits later refund settlement. Jobs are not executed until step 5. See [payment recovery](../../docs/PAYMENTS_AND_BANK_RECOVERY.md).
