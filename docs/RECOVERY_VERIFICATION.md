# Step 6 executed verification

Executed locally on 2026-11-06 with Docker Desktop/Compose and existing persistent volumes. Host Node was unavailable. Work used `feature/cancellation-recovery-redis`, with scoped local commits and integration into develop. No push, volume reset, credential replacement or clearing of financial review debt was performed.

## Commands and observed results

| Command / scenario | Actual result |
|---|---|
| `docker compose --profile bootstrap run --rm --build migrate` | Commerce migration 011 deployed; subsequent run found no pending migrations in Commerce/Billing/Bank (11/8/6). Applied older SQL was preserved. |
| `docker compose --profile tools run --rm --build tools npm test` | Build succeeded; 12 tests passed, including bounded degraded quota flooding/expiry and financial lookup backoff beyond three retries. |
| `docker compose --profile tools run --rm --build recovery-checks` | Real Redis cache/shared quota/overlap/conditional ownership release; owner/unpaid/paid cancellation; current SQL price despite catalog cache; three public cancellation/worker races; fifth-attempt recovery; durable cost review and audited idempotent admin cycle all passed. |
| `recovery-checks redis-down` with Redis stopped and a temporary second Commerce worker | Public catalog/API remained available in local-degraded mode; anonymous/admin escalation denied; paid work completed with one grant; the new-request local quota returned 429 after 120 invalid arrivals. Replica removed and Redis restored in finally. |
| `recovery-checks storage-down` with normal monitor stopped | New admission rejected on false or stale storage observation; accepted cancellation and a separate accepted payment/fulfillment completed. Observation and monitor restored. |
| `recovery-checks storage-sensed` with a temporary monitor using `MIN_FREE_KIB=999999999999` | Actual df-monitor path wrote a fresh unhealthy observation and new order returned 503. No real disk exhaustion or deletion. Temporary monitor removed; normal monitor restored. |
| `docker compose --profile tools run --rm --build foundation-checks` | Real OIDC/ownership/admin boundaries, exact money, immutable evidence, inventory reconciliation, SQL financial guards and bounded catalog paging passed. |
| `docker compose --profile tools run --rm --build checkout-checks` | Concurrent replay, last-unit contention, checkout refresh/expiry, admission/backlog gates, poison/duplicate messages, publication recovery and full-inbox retention passed. |
| `docker compose --profile tools run --rm --build payment-checks` | Concurrent stable payment entry, definite failure, lost response, more than three unknown lookups, immutable 900-second Bank deadline, stale result protection and public cancellation before original command/while UNKNOWN passed. |
| `docker compose --profile tools run --rm --build fulfillment-checks` | Typed effects, real timed transient retry, exact partial/full returns, pending/declined return handling, 60,000-digit money, computed-payload rejection and SQL cutoff/effect guards passed. |
| `docker compose --profile tools run --rm tools node scripts/smoke.mjs` | Readiness, correlation, scoped DB/broker access, OIDC proxy boundary and authenticated Redis passed. |
| `docker compose --profile tools run --rm tools node scripts/reconcile-admission.mjs` | Observed `previousUsed:4, used:4, capacity:200`; live retained slots were not erased. |
| `docker compose --profile tools run --rm --build tools npm run format:check`, `git diff --check` | Passed. Production image validation/prune also reported zero dependency vulnerabilities. |
| `docker compose exec storage-monitor ...` | UID 65534 could read df capacity metadata; `test ! -r /storage/PG_VERSION` passed. |

The excessive-cost scenario executed all 12 failed attempts, advancing private due times to avoid waiting through repeated minute delays. A private timestamp fixture moved recovery age beyond 30 minutes; the actual review/cycle path ran afterward. Attempt 13 succeeded once and all 13 attempt records remained. The separate fulfillment regression exercised a real 10–12-second first retry. These checks do not claim a real 30-minute endurance run.

Initial regression failures exposed earlier assumptions of immediate catalog deactivation visibility and unlimited concurrent gateway requests. Tests now wait beyond the explicit two-second catalog TTL and accept/retry transparent 503 arrivals with the original operation identity. Final assertions still require one order/charge and correct owner/stock/ledger effects; no quota/concurrency protection was removed to make the suites pass.

## Resource observation

All nine steady services reported healthy after restoration. Configured caps total 5,888 MiB / 3.35 cores, including the new 64-MiB/0.05-core monitor. One post-check sample (MiB) was Commerce 152, Billing 104.7, Bank 95.67, Gateway 68.42, Identity 610.1, PostgreSQL 107.4, RabbitMQ 89.8, Redis 6.387 and monitor 1.039. Tool/build containers and temporary verification replicas are outside this steady envelope. Other unrelated host containers were neither changed nor included in this project accounting.

These are startup/post-check observations, not sustainable RPS, p95 latency, a constrained-host benchmark or an availability claim. Financial obligations awaiting review retain admission slots and exact history; a declined simulator return is not changed to success as cleanup.

## Remaining evidence

Step 7 supplies the Persian customer/admin UI. Step 8 measures sustained admitted/rejected throughput, priority/fairness under saturation, long dependency outages, host CPU/memory pressure, disk growth/backup/restore and deployment source-quota tuning. Broker transport remains bounded FIFO; SQL scheduling preference is not broker preemption. A sudden full disk can still stop durable progress until repaired. No unexecuted benchmark or recovery guarantee is marked passing.

For reproducibility, stop Redis/monitor only in an isolated local demo; restore them in finally. Preserve every volume, stable financial key, debt and idempotency record. `compose.yaml` owns the tools profile and its required fixture secrets. No public fault-injection endpoint was added.
