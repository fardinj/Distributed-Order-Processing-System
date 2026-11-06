# Checkout and reliable preparation

Step 3 implementation. Payment entry, charge/refund execution and fulfillment are step 4 onward. Browser flows and the Persian UI remain step 7. Use bearer tokens described in [API_FOUNDATIONS.md](API_FOUNDATIONS.md); no public fault controls or force-state endpoints exist.

## Client API

All paths below are relative to gateway `/api`. Customer identity comes from verified OIDC claims. Admins can inspect an order by ID; list/create/checkout actions use the caller's own customer identity.

| Method/path | Request | Behavior |
|---|---|---|
| `POST /orders` | `Idempotency-Key`, items | Atomic order, admission, snapshots, holds, history and preparation outbox; 201 |
| `GET /orders?limit=25&cursor=<order-id>` | Optional limit 1–100 and opaque previous-page cursor | Caller-owned creation-ordered page; 200 |
| `GET /orders/:id` | Owner or admin | Current committed order, items, checkout revision, live reservations, bounded history and financial projection; 200 |
| `POST /orders/:id/checkout/refresh` | `expectedRevision` | Recheck/reacquire expired checkout; active checkout does not renew its timer; 201 |
| `POST /orders/:id/checkout/confirm` | `expectedRevision` | Confirm a nonempty current basket while its hold is active; 201 |

Example create body:

```json
{"items":[{"productId":"00000000-0000-4000-8000-000000000001","quantity":2}]}
```

Example refresh/confirmation body:

```json
{"expectedRevision":2}
```

Strict bodies reject client prices, totals, statuses and identities. At most 50 input lines and 100 physical units per product, including merged duplicates. Digital/subscription products require one occurrence with quantity 1. Product IDs are normalized and sorted before fingerprinting. Physical duplicate lines merge, so `[A:1,A:1]` and `[A:2]` have the same create identity. Money stays canonical whole-IRR strings and exact BigInt/NUMERIC arithmetic.

Create identity is `(customer, order:create, key)`. Same key plus canonical request returns the existing ID and **current** committed order detail, including later expiry or basket revisions. It does not allocate another slot, renew a timer or restore removed quantities. A changed request returns 409. A different customer can reuse the key. PostgreSQL uniqueness arbitrates across replicas; a bounded local in-flight map only coalesces duplicate work within one process. If the response is lost or returns 503, retry the original key to discover whether it committed.

Unknown/nonowned IDs return 404; stale revisions and stock conflicts return 409; invalid inputs return 400. Exhausted/paused admission, resource pressure and transient database contention return 503. A rejected transaction leaves no new order, key, stock decrement, slot or preparation command. Reads/replays remain usable during admission closure, subject to their own authoritative dependency availability.

## Reservation and revision behavior

Initial checkout snapshots current active products and reserves physical quantities atomically using database time plus five minutes. Its initial basket is confirmed; the client sees the server total before the later explicit payment-entry action. The `expiresAt` field drives the future UI timer. At expiry, a bounded SQL scanner settles ACTIVE holds, marks checkout expired and releases the admission slot once. Scanner lag may delay physical cleanup; refresh also settles due checkout synchronously. No financial operation exists at this stage.

An expired create replay remains expired. Explicit refresh acquires capacity again, locks the order and stock, rechecks the current catalog, and inserts a new immutable revision. Example: 2 physical units were reserved; after expiry only 1 remains. Refresh reserves 1, records the previous/new quantity and `STOCK_CHANGED`, recalculates the exact total, returns `BASKET_CHANGED` and `confirmed:false`. A stale confirmation of revision 1 conflicts; confirmation of revision 2 succeeds. If a product becomes inactive it is removed from the payable snapshot, while its old item and revision remain as evidence. An empty basket cannot be confirmed and holds no admission slot; start a new checkout to add products.

Current catalog name/price/duration changes during an expired refresh also produce a changed revision requiring confirmation, consistent with Q13/Q21. Active holds keep their snapshots until expiry; refresh/confirm never extends the current timer. Removed lines stay `CANCELLED` with `CANCEL` disposition; zero quantities are not stored as payable items.

Expiry matches only editable checkout orders and due ACTIVE reservations. PAYMENT_PENDING/ALLOCATED stock is never released by checkout expiry. Payment promotion will be implemented in step 4 under the same parent/stock locks. If inventory is quarantined by an admin shortage, expiry preserves its zero sellable stock rather than relisting nonexistent units. The discrepancy evidence remains for the later resolution workflow.

Lock order for existing checkouts: parent order, admission budget, items, products by ID, inventory by product ID, reservations by ID. Admin stock operations use product then inventory and do not take admission/order locks. New orders hold only their newly inserted parent before taking budget/stock. This avoids a budget/stock lock inversion between creates and expiry. SQL statement/lock timeouts bound contention; rejected operations roll back.

## Admission and resource defaults

Commerce owns a singleton SQL budget, initially **200** active slots, plus a durable per-order slot ledger. Counter changes and order/stock changes share a transaction. Expired unpaid checkout is settled and releases its slot; refreshing it requires new capacity. Future unresolved payment/refund work must retain its slot until settled. An alert/manual-review label alone cannot release it.

New admission also closes at 10,000 unpublished Commerce outbox rows or 10,000 pending Commerce inbox rows. Local defaults restrict new create transactions to eight, RSS to 512 MiB, and mean event-loop lag to 200 ms sampled each second with a three-second cooldown. They supplement SQL safeguards; they are not a measured host throughput guarantee. Background accepted work continues while admission is closed. Redis is not consulted for correctness.

Operator reconciliation from the durable slot ledger:

```sh
docker compose --profile tools run --rm tools node scripts/reconcile-admission.mjs
```

The command locks the budget, recomputes used slots and refuses to discard slots exceeding configured capacity. It never infers settlement from a guessed payment outcome. The runtime caps/pools remain in [CAPACITY_AND_SCALING.md](CAPACITY_AND_SCALING.md); no additional steady service or pool is introduced.

## Owner-local outbox and inbox

Commerce and Billing each run one bounded transport loop inside their existing process/pool. Commerce publishes `CheckoutPrepared` with order/customer/revision, exact total, immutable payable lines and correlation ID. Billing validates it and maintains its own `prepared_checkouts` projection, then commits `CheckoutPreparationAcknowledged` to its outbox in the same transaction as the projection and receipt. This is preparation only: **no payment row or bank call**. Catalog notifications are durably observed by Billing with no financial effect yet.

Commerce applies acknowledgments monotonically. An old acknowledgment cannot mark a newer revision prepared. Order detail exposes `preparationVersion` and `preparationPending`; the financial projection separately reports `sourceVersion`, status, pending flag and exact confirmed/pending refund amounts. Before payment it reports `NOT_REQUESTED`, version 0 and pending false. Preparation success is never presented as payment success. Later Billing financial result consumers will advance this projection in step 4/5.

Transport properties:

- Dedicated durable `commerce.q.events` and `billing.q.events`, bound to the opposite owner's topic exchange. Existing credentials can publish only their owner's exchange and consume/configure only their own queues.
- Each queue admits up to 1,000 messages/16 MiB, with `reject-publish` overflow, persistent messages and no live-work TTL/drop-head eviction.
- Publishers claim due rows with `SKIP LOCKED`, unique token and 15-second lease. They publish mandatory with a three-second confirm timeout. Only a routed confirm marks SQL published. Return/nack/timeout/disconnect leaves durable retry work, with capped exponential delay and jitter. Expired claims recover after a process crash.
- Consumers prefetch two and commit validated envelopes into their SQL inbox before ACK. Each owner permits at most 10,000 pending inbox entries, with an owner-local transaction advisory lock serializing staging checks across replicas. At capacity, leave the message unacknowledged and reconnect with delay; the broker retains it and its bounded queue propagates backpressure to publishers. Existing duplicate identities can still replay at capacity. Duplicate IDs compare the entire envelope; conflicting content is quarantined. Oversized/invalid envelopes record bounded diagnostic evidence before ACK.
- SQL inbox processing uses row locks, one receipt and local domain effects in one transaction. A savepoint rolls back partial effects/receipt before persisting transient retry timing or permanent quarantine. Transient SQL failures retry with increasing delay, capped at 60 seconds plus up to 500 ms jitter. No immediate nack loop or arbitrary deletion of accepted work.
- Each 500 ms pass attempts at most four publications and four inbox effects. Commerce additionally expires up to eight candidate orders each second. Database time determines due work. Broker reconnects back off; accepted inbox work can continue without the broker.
- No broker-order assumption or exactly-once transport claim. Receipts, versions and unique local effects make duplicate/out-of-order preparation safe. Shutdown stops scheduling, drains active handlers and leaves uncommitted deliveries/leases recoverable.

Message envelopes are version 1 with UUID ID, producer, kind, aggregate ID, generation, correlation ID and payload. The incoming exchange boundary is authenticated by broker permissions; producer labels alone are not trusted. Unsupported kinds/invalid domain contracts become SQL quarantine records for inspection. Repairs must preserve stable message identities; do not purge live queues or mark unresolved work done to clear a backlog.

Executed concurrency/outage evidence and reproduction commands are in [CHECKOUT_VERIFICATION.md](CHECKOUT_VERIFICATION.md).
