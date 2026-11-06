# Typed fulfillment and whole-line refunds

Step 5 executes the durable jobs introduced by payment recovery. Commerce owns product effects, item resolution and the aggregate order. Billing owns refund obligations/budgets and Bank owns actual returns. All amounts remain exact whole-IRR strings/BigInt/NUMERIC. Public cancellation/retry/review actions and Redis features arrive in step 6; the Persian UI remains step 7.

## Local typed effects

`apps/commerce/src/modules/fulfillment/processors/` contains separate digital, subscription and physical processors. Each job locks its parent order first, then the admission budget, item/job and relevant product/stock/resource. It verifies the paid revision, disposition, due generation and cancellation intent before starting. No remote call or sleep occurs in this transaction.

| Type | Effect and replay protection |
|---|---|
| Digital | One entitlement per customer/product and one immutable grant per item; repeat purchases retain the entitlement and record their own grant |
| Subscription | Lock customer/product subscription; extend from `max(expiry, database time)` by the paid fixed-day duration; one immutable extension per item |
| Physical | Consume the item's ALLOCATED reservation and insert one shipment per item/reservation; never decrement sellable stock a second time |

The item success, effect evidence, attempt/history, local job completion, result outbox and aggregate change commit together. A duplicate job for an already successful item is a no-op. Database guards require eligible paid work of the correct type, forbid successful-item rollback, and prevent a refunded item becoming successful. Effect ledgers are append-only to runtime roles.

The first real attempt records immutable `fulfillment_started_at` while holding the parent lock. Setting cancellation intent after this cutoff is rejected by SQL. An accepted earlier intent prevents effects and creates whole-line returns after payment success. The internal protocol is exercised here; customer cancellation eligibility/actions become public in step 6.

## Failure and scheduling

Local effect writes use a savepoint. A classified transient/permanent failure rolls back the grant/extension/shipment before recording its resolution. Known transient work persists RETRY_WAIT and a SQL due time: 10, 20, 40 seconds, then a 60-second base cap, with 0–20% positive jitter. Recoverable work continues; count alone does not force review. Infrastructure failures roll back the entire attempted transaction and defer without committing a business attempt. Step 6 adds broader recoverability/cost checkpoints, circuits and audited manual actions.

The bounded worker scans at most four jobs per 500 ms pass; SQL row locks arbitrate across processes. Candidate scans do not hold resource locks before acquiring the parent. The existing Commerce pool/memory/CPU limits apply. SQL jobs persist through restarts; no item work is discarded to reduce pressure.

Checkout also bounds the UTF-8 serialized server-derived line/total/revision-change work at 250,000 bytes, leaving headroom within the 262,144-byte transport envelope. This is checked before commit, including on refresh. A small request with many huge catalog prices can expand past that bound and receives 413 with all key/order/slot/stock changes rolled back. A single 60,000-digit IRR price is tested unchanged; there is no business amount ceiling or rounding.

Private migrator-only `fulfillment_simulation_rules` can defer identified test items or inject transient/permanent failures after effect writes, proving rollback. They are not product/customer fields or public fault endpoints. Runtime can read them but cannot create/change them.

## Admin stock-count mistakes

An unresolved inventory discrepancy pauses physical fulfillment with `STOCK_REQUIRES_DISPOSITION`. It records a review case and does not spend an attempt or choose which customer loses stock automatically. Successful digital/subscription/other lines remain fulfilled.

```http
POST /api/admin/orders/:orderId/items/:itemId/shortage
Authorization: Bearer <admin-token>
Idempotency-Key: <stable-key>
Content-Type: application/json

{"expectedGeneration":0,"reason":"Warehouse confirmed this paid line cannot be fulfilled"}
```

The action requires a physical, unfulfilled paid line, its current generation, an ALLOCATED hold, quarantined inventory and an OPEN discrepancy naming that hold. It cannot refund a succeeded item or set a custom amount. In one transaction it records actor/reason/audit, a MISSING stock disposition, the immutable whole-line refund obligation, history and RefundRequested outbox. Replay with the same key/body returns the original disposition; changed input conflicts. Inspect current progress through reads.

The disputed allocation is released after confirmed return, without restoring missing/quarantined units to sellable stock. A partially missing multi-unit line still receives a whole-line refund; any physical units awaiting recount remain quarantined for a later explicit inventory resolution. This action does not silently close warehouse-count evidence or guess available stock.

## Refund ownership and protocol

Commerce creates one immutable `item_refund_dispositions` row per failed paid item and sets its disposition to REFUND, excluding future fulfillment. The amount is the paid line total, not the current catalog price. The stable provider key is `refund:<disposition UUID>`. A zero-price failed line settles locally without a Bank return or fabricated refunded money.

Payment commands now include the captured line set. Billing validates the exact set/total and keeps immutable `payment_lines`; a deferred SQL constraint seals the set to the immutable captured amount. Older step-4 headers can obtain the matching revision from the validated preparation projection. Missing prerequisites remain durable inbox retry work.

Billing handles RefundRequested under the payment lock. A refund must match the captured customer/order/revision and one complete paid line. The line can have only one obligation, and confirmed plus outstanding obligations cannot exceed capture. Identity/amount changes conflict or quarantine. Ledger, item allocation, log and initial result outbox commit with the receipt.

The bounded refund scheduler uses SQL due times and 15-second fenced claims, sharing Billing's existing pool. Bank HTTP calls occur outside SQL transactions with Billing-only OIDC identity. Bank serializes captured-budget checks and stores one refund operation per key, with immutable terminal result/reference. Its private `/internal/refunds` POST executes idempotently; GET `/internal/refunds/:key` looks up that identity. These routes are not exposed by the gateway.

Timeout/unreachability leaves UNKNOWN and increasing capped reconciliation for the same key. TIMEOUT_AFTER commits the return before losing its response; lookup recovers it. TIMEOUT_BEFORE fixtures retain a pending operation for a configured number of attempts before execution succeeds. A definitive provider decline becomes REVIEW_REQUIRED, remains owed and keeps admission/resources; it is not a successful return or an excuse to create another obligation/key. Provider repair/manual recovery actions require the later review workflow.

## Projection, history and finality

Each RefundStatusChanged contains the full immutable identity, per-refund source version, a payment-wide financial version, authoritative confirmed/pending totals and one immutable log entry. Commerce retains valid logs even if a later status arrived first. Per-refund versions prevent state regression; the financial version prevents an older sibling refund snapshot overwriting newer totals. Pending display includes locally committed obligations still travelling to Billing.

- `financial.status` remains the charge outcome; `financial.summary` is NONE, PARTIALLY_REFUNDED or REFUNDED based only on confirmed returned money.
- `refundedMinor` is confirmed; `pendingRefundMinor` includes unresolved/review obligations. UNKNOWN is not returned money.
- COMPLETED requires every payable item succeeded. Mixed/full failed-line resolution finishes as RESOLVED after refunds settle, with successful effects retained. Accepted cancellation settles as CANCELLED.
- Admission releases once only after all item effects/refund obligations settle. Human review and outstanding money remain counted.

Owner/admin reads:

| Route | Response |
|---|---|
| `GET /api/orders/:id` | Item generation/attempt counts, grants/extensions/shipments, order history and financial projection |
| `GET /api/orders/:id/refunds?limit=25&cursor=<id>` | Whole-line dispositions, amounts, statuses, source versions and provider references |
| `GET /api/orders/:id/refunds/:dispositionId/logs?limit=25&cursor=<id>` | Append-only projected refund logs |

Pages are bounded at 100. Nonowners receive 404; admin shortage writes require admin role. Cursor comparisons preserve SQL timestamps and scope. No UI or public retry/cancel shortcut bypasses these rules. Reproduction and executed evidence are in [FULFILLMENT_VERIFICATION.md](FULFILLMENT_VERIFICATION.md).
