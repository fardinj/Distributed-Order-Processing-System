# Commerce

Owns orders, checkout revisions, catalog, stock/reservations, local fulfillment, item dispositions and order history. Digital/subscription/physical processors will be separate modules in this service, sharing its short SQL transaction boundary.

`src/modules/catalog` implements protected catalog/admin mutations, audit/idempotency and guarded stock reconciliation. `src/modules/orders` supplies owner-protected snapshot reads; checkout/workers are later. `src/database.ts` manages the owner Prisma/pg adapter pool; `database-errors.ts` maps expected persistence conflicts safely.

`prisma/` contains the owned model and forward SQL migrations, including unconstrained monetary fields, partial indexes, append-only runtime privileges and immutable snapshots. Never use another owner's client or edit applied migration files. Runtime receives its DB credentials, never the migrator password. Total pool budget reserves one health connection; other slots belong to Prisma.
