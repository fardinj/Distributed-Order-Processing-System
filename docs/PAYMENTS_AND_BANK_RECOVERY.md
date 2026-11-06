# Payment entry and bank recovery

Step 4 implements payment entry, bank execution/reconciliation, terminal stock transitions and durable fulfillment dispatch. Typed fulfillment/refund execution is step 5. Public cancellation/retry actions are step 6; the Persian UI remains step 7. The cancellation protocol described below is an internal foundation, not a finished customer cancellation API.

## Customer contract

```http
POST /api/orders/:id/payment
Authorization: Bearer <customer-access-token>
Content-Type: application/json

{"expectedRevision":1}
```

Only the owner may enter payment. Unknown/nonowned orders return 404; stale revisions return 409; extra amount, identity, status or simulator fields return 400. The response is the current order detail (201), with `paymentOperationKey`, workflow status, reservations and a financial projection. Accepted payment entry queues work; it is not a promise of successful payment or an external redirect. The future demo UI invokes this endpoint as its simulated gateway action and polls protected order detail.

Each order has one stable `payment:<order UUID>` identity. Repeated entry returns current progress without another charge or stock mutation; a definitive decline cannot create another financial attempt under a fresh key. Start a new checkout if the customer wants another logical payment. When entry itself reacquires an unchanged expired basket, replay accepts either the original entry revision or the resulting current revision. An unrelated stale basket revision is still rejected.

Entry locks the parent, settles/reacquires expired stock and promotes payable ACTIVE holds to PAYMENT_PENDING with no checkout expiry. The immutable amount/revision and `PaymentRequested` outbox commit in that transaction. A changed basket instead commits a new revision and returns `BASKET_CHANGED`, with no payment command; the customer must confirm it and use its new revision. A known unresolved stock discrepancy blocks payment before charging. Payment calls never hold these SQL locks while contacting Billing/Bank.

Example: checkout reserves 2 units until 12:05. Entry at 12:04 promotes those holds, so an old 12:05 expiry cannot release them. If entry is after expiry and only 1 unit is available, return a changed revision holding 1 unit for confirmation. If the same 2 units remain available, reacquire and promote atomically. Confirmed paid snapshots remain immutable.

## Billing workflow

Commerce publishes a self-contained payment header: operation key, order/customer, checkout revision, exact whole-IRR amount, currency and correlation ID. It does not depend on arrival of the earlier preparation message. Billing validates the producer/envelope/header, creates one immutable payment ledger entry, and commits receipt plus initial status outbox together. Conflicting monetary identities are quarantined rather than charged.

The recovery scheduler claims at most two payments each one-second pass using SQL due times, `SKIP LOCKED` and a 15-second claim token/lease. HTTP runs after claim commit, outside any SQL transaction. Bank calls use a cached OIDC Billing service token and 1.5-second request timeout; correlation IDs propagate. The result transaction checks the claim token before applying observations, appends an attempt, updates due time and publishes a versioned status. A stale claimant cannot overwrite a newer claimant; external retries still use the same bank key.

The worker looks up that key before initialization/execution. A known missing operation can be initialized idempotently, then executed. A known PENDING operation may be executed again with the same key, including recovery from a crash between init and execute. Network failure, HTTP timeout, authentication/dependency failure or an invalid bank response means UNKNOWN, never a local financial decline.

UNKNOWN continues automatic recovery beyond three attempts. Initial lookup spacing is 2 seconds, then 4, 8, 16, 32 and a 60-second cap, plus 0–500 ms positive jitter. Due times are clipped toward a known bank deadline; after an unreachable deadline, bounded lookups continue until Bank can confirm a terminal result. This is financial reconciliation, not the fulfillment retry budget. No local 15-minute timer fabricates failure or releases stock. Attempt counts, results and due times survive restarts.

## Bank-owned authority

Private Billing-only endpoints:

| Method/path | Effect |
|---|---|
| `POST /internal/charges/init` | Initialize `{operationKey,amountMinor,currency}` once; fix bank start/deadline |
| `GET /internal/charges/:key` | Return authoritative current status, settling a due pending operation |
| `POST /internal/charges/:key/execute` | Execute the original operation idempotently |
| `POST /internal/charges/:key/cancel` | Fence a no-charge identity or report an already successful charge |

Customer/admin/Commerce service tokens cannot execute these endpoints. The gateway does not route them. Bank owns its DB, runtime pool and terminal state; Billing has no Bank DB credentials. Cancellation and initialization serialize by operation-key transaction advisory lock; row locks serialize execution, lookup, cancellation and deadline finalization.

The first durable Bank initialization sets `deadline_at = initiated_at + 900 seconds`, using Bank DB time. Neither reinitialization nor worker restart renews it. A one-second bounded scanner finalizes up to 32 due PENDING operations; lookup/execute also check the deadline under the row lock. Once FAILED it cannot later charge. Once SUCCEEDED it cannot be replaced by a deadline failure, and its bank reference stays immutable.

Deterministic simulator outcomes are selected privately through migrator-owned `bank_simulation_assignments` referencing seeded `simulation_rules`. Bank snapshots the selected outcome at initialization; runtime cannot edit assignments/rules. With no assignment, the default is success. No customer outcome parameter exists.

| Fixture | Behavior |
|---|---|
| `SUCCESS` | Commit one SUCCEEDED charge and bank reference |
| `FAIL` | Definitive FAILED result |
| `TIMEOUT_BEFORE` | Remain PENDING and return simulated ambiguous HTTP 504; Bank eventually fails at its deadline |
| `TIMEOUT_AFTER` | Commit SUCCEEDED, then return simulated ambiguous HTTP 504; a lookup recovers that original success |

The 504 fixtures model unavailable responses after the DB transaction; they do not sleep or roll back a committed charge. Monetary strings remain exact through API, Prisma/SQL, Bank and result envelopes, including values beyond safe Number/BIGINT.

## Commerce projection and stock

Billing emits complete `PaymentStatusChanged` snapshots with source version, immutable identity/revision/amount, Bank reference/deadline, status and correlation. Commerce validates them against the payment-entry snapshot, then commits receipt, projection, order history and stock/job effects together. A newer snapshot can arrive before an older one. Lower/equal versions are no-ops; a terminal result cannot regress. Mismatched money/revision/customer/key is quarantined.

Order detail exposes financial `sourceVersion`, status, `pending`, `bankReference` and `bankDeadlineAt`. `pending:true` means the financial result is unresolved or still being delivered, not a successful charge. `PAYMENT_REVIEW` is the visible UNKNOWN workflow state; reconciliation continues automatically.

- SUCCEEDED: change PAYMENT_PENDING holds to ALLOCATED without another stock decrement. Insert one READY `fulfillment_jobs` record per payable item in the same transaction and show PROCESSING. The admission slot remains live until later fulfillment/refund settlement. Step 5 will execute those jobs.
- FAILED: change eligible holds to RELEASED and replenish valid sellable units once; release the admission slot once and show PAYMENT_FAILED. Quarantined/nonexistent stock is not relisted.
- UNKNOWN or delayed result: retain payment-owned stock and admission. Checkout expiry cannot touch it.

## Cancellation fencing foundation

`PaymentCancellationRequested` carries the same immutable header. Billing can receive it before the original `PaymentRequested`: it creates/validates that identity and writes a REQUESTED tombstone atomically with its receipt. The scheduler prioritizes cancellation for that payment. Bank persists its own cancellation fence even if initialization has not arrived. Only an authoritative Bank no-charge result permits Commerce to release payment-owned stock; delayed original commands and direct Bank init/execute then remain no-charge.

If charge won the race, success remains success. Billing marks the cancellation `REFUND_REQUIRED` and emits the known paid state. Commerce with a cancellation intent retains ALLOCATED stock/admission, shows CANCELLATION_PENDING and suppresses READY/DEFERRED fulfillment jobs. It does not claim a refund occurred. Refund obligations/execution and public cancellation eligibility arrive in steps 5/6. Test fixtures set the intent through controlled SQL; there is no public force-state/cancel shortcut in this milestone.

Operational rule: never reset payment keys, manually release unknown stock, delete tombstones or relabel UNKNOWN as FAILED to clear a backlog. Restore dependencies and let due work/expired leases reconcile the original operation. Exact reproduction and executed evidence are in [PAYMENT_VERIFICATION.md](PAYMENT_VERIFICATION.md).
