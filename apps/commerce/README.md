# Commerce

Owns orders, checkout revisions, catalog, stock/reservations, local fulfillment, item dispositions and order history. Digital/subscription/physical processors will be separate modules in this service, sharing its short SQL transaction boundary.

`src/main.ts` currently wires the shared runtime/health only. `prisma/schema.prisma` and `prisma.config.ts` belong only to the Commerce database; domain migrations are next. Add feature folders under `src/modules/` when implemented, rather than mixing handlers into `main.ts` or the shared runtime. The app receives runtime DB credentials, never its migrator password.
