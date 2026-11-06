# Bank simulator

Step 4 implements Billing-only `internal/charges` init/lookup/execute/cancel APIs in `src/charges.ts`, using the private Prisma pool in `src/database.ts`. Durable initialization fixes the 900-second deadline; row/advisory locks, terminal guards and no-charge tombstones fence duplicates/cancellation/deadline races. A bounded scanner fails due pending operations. Private fixtures choose success, decline or timeout before/after charge; no customer fault override exists. See [payment contracts](../../docs/PAYMENTS_AND_BANK_RECOVERY.md).

Runtime receives only Bank DB credentials and verifies Billing OIDC service identity; it has no broker, migrator or other-owner DB credentials. SQL protects exact money, fixed deadlines, immutable terminal outcomes and refund budgets. Refund execution is a later milestone.
