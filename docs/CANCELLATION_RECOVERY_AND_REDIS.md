# Cancellation, recovery and Redis

Step 6 implements selected Q04/Q05/Q09/Q14/Q15/Q20. These engineering defaults refine selected policies; no new business decision is pending. Executed evidence: [RECOVERY_VERIFICATION.md](RECOVERY_VERIFICATION.md).

## Public actions

All routes require a verified bearer token; Commerce repeats ownership/role checks. Mutations require `Idempotency-Key` (1–128 ASCII characters). Changed input under the same key returns 409. Replays return the original action acknowledgment; order GET returns current progress. Create-order replay still returns current order status.

| Route | Input / access | Behavior |
|---|---|---|
| `POST /api/orders/:id/cancel` | Owner; `{expectedVersion, reason}` | Version is `workflowVersion` from order detail. Parent lock serializes payment entry, cancellation and first fulfillment start. |
| `POST /api/orders/:id/items/:itemId/retry` | Owner for due RETRY_WAIT; admin also for RECOVERY_COST review | `{expectedGeneration, expectedRetryVersion, reason}` from item detail. Opens an audited cycle, retaining total attempts and item identity. |
| `GET /api/orders/:id/items/:itemId/attempts?limit=25&cursor=UUID` | Owner/admin | Chronological attempts, at most 100/page; cursor belongs to this item. |
| `GET /api/admin/manual-review?limit=25&cursor=UUID` | Admin | `{items,nextCursor}` of chronological open cases; replaces the earlier array. |
| `GET /api/admin/manual-review/:id` | Admin | Case, item/refund state and allowed action identifiers. |

Example: read `workflowVersion: 2`, then cancel with `expectedVersion: 2` and reason `Customer changed delivery plans`. Cancellation wins the shared parent lock: record intent and prevent every item from starting. Worker wins: `fulfillmentStartedAt` is immutable and cancellation returns 409, even if that first attempt subsequently fails. An admin can cancel only their own order through the customer endpoint; review/shortage permissions are separate.

Unpaid cancellation releases ACTIVE stock and the admission slot once. Entered-payment cancellation publishes the immutable original command as `PaymentCancellationRequested`; Billing obtains a no-charge fence or the actual capture result. UNKNOWN keeps payment-owned stock reserved. Later success suppresses fulfillment and creates whole-line refunds; definite failure/no-charge releases without a refund. Paid cancellation stays CANCELLATION_PENDING until obligations settle. Cancellation status and confirmed money/refund summary remain separate fields.

Succeeded or refund-resolving items cannot retry. Quarantined stock uses the recorded shortage-disposition endpoint. Definitively declined returns remain visible obligations; this API provides no force-success, arbitrary replacement amount, new financial key or fabricated external settlement. Inspect refund logs and repair the provider/operational cause. The simulator's immutable terminal decline cannot become success through admin retry. UNKNOWN financial reconciliation continues independently.

## Recovery policy

A normal cycle is initial execution plus three retries. Delays after failures 1–3 are 10/20/40 seconds with 0–20% positive jitter. After the fourth transient failure, defer 60 seconds; subsequent groups of four back off to 120/240/300 seconds plus jitter. Permanent errors enter whole-line refund resolution directly.

Four failures alone do not imply review: a cheap transient item can succeed once on attempt five. The excessive-cost checkpoint requires **both** at least 12 failed executions since the last explicit cycle and at least 30 elapsed minutes without item progress. It creates RECOVERY_COST review, stops dispatch and retains admission accounting. An admin may open a reasoned, idempotent cycle after changing conditions. Retry version advances on attempts, cost-review transition and explicit cycles; stale actions conflict. Total attempts never reset.

Infrastructure transaction failures roll back effects and attempt evidence, then defer under a fresh parent lock with increasing 10–300-second delays. They do not spend business attempts or infer financial failure. Commerce RSS over 512 MiB defers item work for 60 seconds. Local typed processors do not depend on broker health. Payment/refund schedulers remain independent; financial UNKNOWN lookup has no three-attempt ceiling. Stock quarantine opens review and periodically checks prerequisites without executing effects or choosing a losing customer.

## All three Redis uses

* **Read cache:** authenticated public catalog list/detail, TTL 2 seconds, value at most 256 KiB. No principal, authorization, order, financial truth or admin read cache. Catalog edits/deactivations and stock displays may remain stale for the TTL. Checkout always locks/revalidates PostgreSQL prices, stock and active status. Failed reads and oversized values bypass storage.
* **Scheduler overlap:** Commerce fulfillment/cancellation sweep uses SET NX, random owner token, 15-second expiry and conditional Lua release. Expiry, pause, eviction, restart or Redis failure may overlap workers; SQL parent/item locks, generations and unique ledgers still arbitrate. A crashed holder delays competitors by at most its remaining TTL.
* **Quotas:** atomic Redis increment/expiry, fixed UTC minute buckets. Gateway pre-auth traffic: 6,000/minute/socket-source; separate token/auth POST: 5/minute/source. Authenticated principal lanes: reads 1,800, new-order POST 120, admin mutations 180, existing-work actions 600 per minute. These demo/developer defaults replace the earlier proposed 60/30 values to permit bounded polling/integration bursts; deployment abuse/load tuning remains necessary. Internal financial reconciliation has independent capacity.

Optional Redis operations have a 250 ms outer deadline, offline queue disabled and one-second failure cooldown. Failure bypasses cache/overlap lock and enables bounded local minute counters: 4,096 identity/lane entries plus one shared overflow bucket. Flooding new identities cannot evict active quotas. `X-Rate-Limit-Mode: local-degraded` advertises weaker enforcement; 429 includes Retry-After. Replicas have independent counters; restart resets them, recovery switches counters and fixed-window boundaries allow bursts. Redis allkeys-LRU can also evict quota/lock entries, so these are auxiliary controls rather than strict admission safeguards. Authentication, authorization, validation and SQL admission remain enforced. Source quotas use the actual socket address; deployments behind another proxy need an explicit trusted-source policy.

## Pressure, priority and storage

Gateway active domain requests: 24 ordinary plus eight existing-work mutations. Before Redis/JWT waits, a separate edge bound permits 48 ordinary and 16 existing-work requests. Saturation returns 503/Retry-After before accepting business work. Payment/checkout/cancel/retry actions have a separate lane. Each four-message SQL outbox/inbox batch prefers financial results, refunds and cancellations for three selections, then selects oldest due work for fairness. Billing payment/refund schedulers and Commerce admitted work run independently of new admission. Bounded broker queues retain FIFO transport; priority is applied in durable owner scheduling, not broker preemption. Reject-publish overflow retains accepted messages and failed publications stay in SQL.

`storage-monitor` observes the PostgreSQL volume filesystem every five seconds. New admission requires 2 GiB free, less than 90% used and three consecutive good samples to reopen. Bad observations close admission; observations older than 30 seconds also close it. `storage_healthy/storage_checked_at` are independent of the operator's `accepting_new` switch. The monitor uses UID/GID 65534 and a read-only volume mount: it can inspect filesystem capacity but cannot read PostgreSQL-owned data files. Its only credential is Commerce runtime access. Health means observations are fresh, not that space is plentiful.

This is early admission protection, not a guarantee against sudden disk exhaustion. Broker disk, host logging, WAL, disk growth and backup/restore still require host monitoring/reserves. Accepted work is never deleted to recover capacity, but prolonged resource loss can stop progress until repaired. Monitor adds 64 MiB/0.05 CPU; steady caps total **5,888 MiB / 3.35 cores** within the selected 8 GiB/four-core envelope. These limits are not a load benchmark; step 8 measures saturation, fairness and sustainable admitted throughput.

## Operational examples

* Redis down: catalog uses SQL, local quotas are advertised, SQL guards protect concurrent workers. Restore normally; never replace financial keys or reset ledgers.
* RECOVERY_COST: inspect case/item/attempts, fix the cause, submit admin retry with current generation/retry version and reason. Replay the same key after response loss. Success/refund or stale inputs conflict.
* Admission 503: distinguish active-request saturation, SQL slots/backlogs, manual pause and stale/low-storage observations. Restore capacity and retry the original create key; never clear live slots or mark debt settled.
* Scale up: measure queue age, SQL wait, drain rate and memory first. Increase the host envelope/pools together or split API/workers within each owner budget. Gateway/worker replicas share Redis but retain SQL guards and a combined connection budget. Separate durable database/broker storage and verify backups before promising availability. Debts and idempotency identities survive scaling.
