# Load and overload evidence

Executed 2026-11-07, run `2796bc84`, 11:19:31–11:22:20 UTC. This finite run characterizes the configured development system; it does not establish a production SLA or sustained capacity.

The workload used eight real OIDC customer principals, two Gateway instances, one 100 IRR digital item per order, real PostgreSQL/RabbitMQ/Billing/Bank and concurrent payment initiation. New requests were capped at 64 in flight in the external driver; payment calls at four. Every sent create key was reconciled against SQL, including ambiguous responses. Public authentication and quotas remained enabled. A separate 100-request/five-unit physical-stock race passed.

| Stage | Offered rate / window | Sent | Accepted 201 | Rejected 503 | Response p50 / p95 / p99 / max |
|---|---|---:|---:|---:|---|
| Baseline | 1/s / 20s | 20 | 20 | 0 | 17 / 21 / 35 / 35 ms |
| Ramp | 6/s / 30s | 180 | 180 | 0 | 15 / 24 / 91 / 112 ms |
| Pressure | 20/s / 30s | 600 | 113 | 487 | 7 / 15 / 49 / 127 ms |

Pressure-stage measured response rates: 3.77 accepted/s and 16.26 rejected/s. Rates use elapsed dispatch-to-last-response duration; configured stage windows are shown separately. Mixed response percentiles include cheap rejection responses and are not accepted-order processing latency. There were no 429s, transport failures or client-side discarded requests in this run.

All **313 SQL-accepted orders completed**: 313 items, grants, actual execution attempts, successful Billing payments and exact Bank operations; no retained slots for these orders. The other 487 keys left no accepted order. Completion latency from SQL order creation to its durable COMPLETED event: p50 60.816s, p95 97.986s, p99 99.513s, maximum 100.085s. This includes queueing, the payment driver and eventual cross-owner projection. It demonstrates bounded acceptance and drain, while showing that batching/polling throughput needs tuning before claiming low-latency service.

SQL samples every two seconds observed admission peaking at its hard 200 cap (four pre-existing unresolved review slots remained throughout), Commerce unpublished outbox 342, Billing outbox 190, Billing unresolved payments 98, Commerce/Billing pending inbox 4/3. Oldest *due* Commerce outbox age peaked at 42.633s; this measures `available_at`, not original commit-to-delivery lag. Lock waiters were zero at sample instants; short waits between samples are not excluded. Connection counts including verification clients peaked at Commerce 6, Billing 5, Bank 3. At completion there were four pre-existing slots, zero unresolved Billing payments, zero pending inboxes, and four recently created Commerce completion notifications; business drain does not imply the final notification was already published.

## Resource observations

The nine steady services have combined hard limits **5,888 MiB / 3.35 CPUs**. The temporary second Gateway adds 192 MiB / 0.20 CPU, totaling **6,080 MiB / 3.55 CPUs**, leaving headroom within the selected 8 GiB / four-core server budget. The external load driver is separately capped at 768 MiB / 0.50 CPU. Bootstrap/build/verification tools are not steady services.

Docker reported a shared host with **20 CPUs, 16,568,717,312 bytes RAM and cgroup v2**, with other projects present. Per-container caps were enforced; the physical host was not dedicated or restricted to four cores/8 GiB. Host page cache, shared workload, burst scheduling and unsampled peaks limit extrapolation. Repeat on a dedicated constrained host before choosing production admission/RPS targets.

34 Docker samples, roughly five seconds apart:

| Container | Maximum sampled memory MiB | Maximum sampled CPU % of one core |
|---|---:|---:|
| Gateway | 86.10 | 7.41 |
| Additional Gateway | 70.97 | 2.68 |
| Commerce | 159.40 | 30.94 |
| Billing | 111.10 | 14.81 |
| Bank | 105.60 | 6.62 |
| PostgreSQL | 129.40 | 21.40 |
| RabbitMQ | 172.20 | 39.72 |
| Redis | 8.63 | 2.39 |
| Identity | 647.10 | 2.01 |
| Storage monitor | 4.64 | 4.21 |

These individual maxima are not simultaneous whole-host usage. No driver OOM was recorded. Queue age, CPU and memory observations are sampled, not continuous profiling; RabbitMQ queue age and HTTP accepted-only percentiles were not instrumented in this run. Backlog measurements are SQL outbox/inbox counts, not broker queue depth.

## Reproduce and interpret

After normal setup, migrations, fixture provisioning and healthy startup:

```powershell
powershell -NoProfile -File scripts/verification/load.ps1
```

The runner creates a temporary Gateway, builds/runs the driver, captures resource samples, archives previous load outputs and removes only its disposable containers. Accepted history remains. Reports are private under `.local/verification/`: `load-results.json`, `load-resources.jsonl`, `load-console.txt`, `load-limits.txt`. Fixture clients are disabled and the product deactivated after success; interrupted runs require inspecting their known run identities before cleanup. Never reset the ledgers to make a benchmark pass.

An earlier run completed 305 orders but its metric sampler referenced a nonexistent timestamp column. Its instrumentation-error report was retained separately; it is not the passing measurement above. The corrected run validates sampling before dispatch. Optimization should first address measured outbox/projection lag and polling fairness, then rerun this workload and a longer soak with mixed products/refunds and larger amounts. See [capacity and scale-up](CAPACITY_AND_SCALING.md).
