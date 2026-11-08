# Operations and recovery runbook

This is a single-host development deployment with durable SQL ledgers and eventual messaging. It has no automatic host failover. Keep the original secrets, PostgreSQL volume, retained owner outboxes and backup archives; a clean installation is not a recovery procedure for accepted orders.

## First checks and safe restart

```sh
docker compose ps
docker compose logs --since 10m gateway commerce billing bank-simulator storage-monitor
docker compose up -d --wait --wait-timeout 300
```

Use request ID, order ID, item/disposition ID and stable payment/refund identity to correlate records. Check `/health/ready`, then the owner-authenticated order/refund/attempt/review APIs. A 201 or a UI pending state is not a financial terminal outcome. Never print credentials/access tokens or publish local verification artifacts. Readiness, structured logs and SQL evidence are available; centralized metrics/alerts and a long-running observability service remain deployment work.

Check admission usage, oldest due SQL work/outbox, unresolved payment/refund age, open review cases, inbox quarantine, pool/lock waits, disk/WAL growth and broker alarms. Sample each owner's database through its approved operational identity, not another service's runtime account. SQL inspection is diagnostic; repairs need a reason, backup and scoped review. Do not blanket-update payment status, delete inbox receipts, reset counters or mint a new financial identity.

## Payment or refund UNKNOWN

1. Inspect Commerce's projected status/source version and Billing's original operation/attempts. Verify Bank/Identity/network health and the scheduled next lookup. Restore the dependency, then let durable reconciliation run.
2. Reuse the existing operation key. Bank success after a response timeout must reconcile the original charge/return; starting a replacement risks duplicate money movement.
3. Keep payment-owned stock protected until an authoritative terminal result/no-charge fence is applied. Fifteen minutes is Bank's durable PENDING deadline, not permission to mark a locally unreachable operation failed.
4. A return obligation is not returned money until Bank confirms success. Retain captured/refundable budgets, refund logs and the admission slot while money is unsettled. Failed returns require diagnosis/review; do not report REFUNDED or relist phantom inventory.

Payment/refund lookups use increasing SQL-scheduled delay with positive jitter and continue beyond three attempts. No SQL lock is held across provider HTTP. After outage recovery, verify one terminal bank operation, matching Billing result and eventually matching Commerce projection. A stale projection is not a reason to issue a second operation.

## Item retries, review and stock shortage

The normal fulfillment cycle is initial execution plus three automatic retries with exponential delay/jitter. Recoverability and cost decide continuation; outages/pressure cause durable deferral. Succeeded/refund-resolving items cannot rerun.

Inspect `/api/admin/manual-review`, its case detail and item attempt history. For an eligible RECOVERY_COST case, repair the cause and use the normal item retry endpoint with admin token, latest generation/retry version, reason and stable key. Re-read after 409. Permanent physical shortage uses the guarded admin shortage endpoint after investigating actual stock. It creates the whole-line disposition/refund obligation while preserving successful items and counted-stock evidence. No generic “mark complete” or arbitrary manual charge/refund endpoint exists.

## Redis, broker and quarantined messages

Redis failure bypasses catalog cache and scheduler lock; SQL claims, parent locks and effect uniqueness remain authoritative. Gateway returns `X-Rate-Limit-Mode: local-degraded`: quotas are bounded per instance, weaker than the shared Redis limit, and may reset on restart. Restore Redis and confirm shared mode. Never disable JWT/role checks to preserve availability.

RabbitMQ queues reject excess publication; live work has no drop-head/TTL eviction policy. A publisher confirm/routing failure leaves the SQL outbox available for retry. Reconnection/lease recovery republishes with the same message ID. Recipient acknowledges only after a durable inbox handoff; SQL processing then commits receipt/effect/result together. Check outbox backlog/due age as well as broker depth: an empty queue does not prove completion.

Malformed/conflicting events are retained in owner `message_quarantine` and/or quarantined inbox state with reason/evidence. This implementation uses SQL quarantine, not a separate operational DLQ/redrive API. Inspect the originating outbox/envelope, durable recipient inbox/receipt and version guards before repair. Transient processing failures reschedule; malformed financial input must never be blindly replayed or converted to success. Correct producer/schema/permissions first, then perform a narrowly reviewed owner repair preserving original operation/message identity. Unsupported automatic redrive remains manual operational work.

## Overload and storage pressure

New work receives 429 for quota or 503 for shared admission/dependency pressure. Clients retain the same create key across transient/ambiguous failures. SQL capacity is 200 unsettled orders; review cases with unresolved money still count. Prioritize accepted financial outcomes/reconciliation and completion before increasing new arrivals.

The filesystem monitor uses fresh observations and hysteresis; stale/unhealthy storage closes admission. Restore sufficient disk headroom and allow healthy samples before reopening. Archive only verified settled history with an explicit retention design; the current implementation intentionally retains outboxes/receipts. Never purge live queues, accepted orders, financial history or volumes to make space. [Capacity defaults and scale-up](CAPACITY_AND_SCALING.md) and [measured limits](LOAD_RESULTS.md) explain the current envelope.

## Metrics and history

Use an admin bearer token at `GET /api/admin/metrics` for Commerce, or a recognized service token on the private Commerce/Billing `GET /internal/metrics`. These return Prometheus text, not JSON. Customer/anonymous requests are denied. Domain collection is cached for five seconds with one concurrent SQL refresh per owner; a failed refresh returns 503 instead of fabricated zero counts. No new database pool or monitoring service was added.

Commerce exposes admission use/capacity, unpublished outbox count/oldest due age, pending inbox/jobs, retry-wait items, open reviews and unknown payment projections. Billing exposes unpublished outbox, pending inbox, unresolved payments/oldest age, unknown payments and unconfirmed refunds (including failed returns still owed). Both include current RSS/uptime/process CPU and completed HTTP response-class counters. CPU/counters reset on process restart; domain values survive because they are read from SQL. The snapshot timestamp distinguishes cached observations. Oldest *due* outbox age is not original event age. HTTP response counts are not SQL acceptance counts, and sockets closed before a response completes are not counted.

Scrape with a protected operational service identity and alert on stale/missing observations, sustained backlog age and prolonged financial uncertainty. No collector, dashboard, alert delivery, broker queue-age exporter or distributed tracing is bundled. Use verification/owner diagnostics for DB waits and broker depth. Do not add order IDs, customer IDs or raw URLs as metric labels.

Complete order history is available through the owner/admin events endpoint with bounded cursor pages; detail intentionally keeps its recent 100-event window. Start/effect/shipment entries and item attempts commit atomically; a process killed before commit cannot leave a false successful event. Historical events predating the new sequence/start events are retained without inventing missing facts.

## Consistent backup and isolated restore

The provided maintenance rehearsal stops new admission, stops all writers (Gateway, owners, Identity and monitor), fingerprints each owner's public tables, then makes four PostgreSQL custom-format dumps with owner credentials. RabbitMQ is stopped too; the quiescent SQL snapshot is the recovery authority. PostgreSQL is stopped before a separate full stack starts, keeping resource budgets bounded. This requires planned downtime.

```powershell
powershell -NoProfile -File scripts/verification/durability.ps1
```

The runner first builds migration/seed tools, preserves existing source credentials/data, and creates two uniquely named Compose projects. Fresh-install proof uses newly generated secret files and empty data volumes. Restore proof uses original role credentials with **new target volumes**, validates a distinct PostgreSQL system identifier and empty databases, verifies archive hashes, restores without `--clean`, and compares full row-count/SHA-256 table fingerprints before starting writers. Sequence/schema/privilege definitions are carried by `pg_dump`/`pg_restore`; runtime isolation is checked again by smoke tests.

Redis cache is rebuilt. Fresh RabbitMQ is reconstructed by comparing retained Commerce/Billing outbox IDs to the other owner's durable inbox; only missing handoffs are marked for republish, retaining message IDs and all financial/effect identities. Run this operation only on the guarded isolated target, never a live source. The snapshot includes Identity sessions/client credentials and a paid, deferred large-IRR order; the test resumes that work once in the restored target and once after returning to the original source. Isolated target financial effects are simulator-only and must never contact a real provider.

The source is restarted and its original admission switch restored in `finally`. Both test projects are stopped with their volumes retained for inspection. Do not run them concurrently with the source as a real business environment. `compose.verify.yaml` overrides image names, credential paths and identity report mounts; it does not point at original named data volumes.

Archives/manifests live under `.local/verification/backups/<run>/`. They contain sensitive account/financial data and password hashes: keep them private, encrypt/copy them to a separately secured failure domain for actual disaster recovery, and preserve required secret material through a protected process. Current local files are neither an encrypted vault nor off-host backup. Cleanup/retention is explicit operator work; verification does not delete previous backups or volumes.

RPO for this quiescent rehearsal is the exact stopped snapshot: no source writes occur between fingerprints and dumps. It proves restoration of that snapshot, not recovery of writes after it. Production RPO depends on backup/WAL frequency and external-provider reconciliation; neither continuous archiving nor real-provider disaster reconciliation is implemented. There is no production RTO commitment; the rehearsal includes cold Identity startup and intentional source downtime. For lower RPO/RTO, add protected off-host backups, tested PITR/replication and provider reconciliation before opening traffic. A standalone database dump from four actively changing owners is not a consistent distributed checkpoint.
