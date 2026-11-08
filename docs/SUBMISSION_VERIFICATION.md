# Step 8 verification and submission evidence

Follow-up on 2026-11-08 added status/date filters, complete paginated history, protected metrics and controlled SIGKILL tests for all three item types. See [follow-up results](SUBMISSION_GAPS_VERIFICATION.md). The results below remain the dated step-8 measurement record.

Executed locally on **2026-11-07** using Docker Desktop/Compose, Node 24.15.0, PostgreSQL 17.11, RabbitMQ 4.3.7, Redis 8.8.4 and Keycloak 26.8.1. Work was performed on `feature/verification-and-submission`. Original credentials, volumes, accepted orders, financial obligations and review debt were preserved. Raw reports/backups remain gitignored and private.

## Executed results

| Check / command | Observed result |
|---|---|
| Final `docker compose --profile tools run --rm tools npm test` | Build/TypeScript/client generation succeeded; **14 tests passed**, zero failures/skips. |
| `tools npm run validate:schemas` / `tools npm run format:check` | All three owner schemas and repository format check passed, including verification Compose configuration. |
| Production Gateway/Commerce builds | Schema validation and build passed; production dependency prune/audit reported zero vulnerabilities. This is a package-audit observation, not a penetration test. |
| Two-Gateway load, real OIDC, 800 new arrivals | 313 SQL-accepted/completed; 487 explicit 503 responses left no accepted identity; every accepted order had exactly one exact charge/grant/attempt and released its slot. [Detailed measurements](LOAD_RESULTS.md). |
| `submission-checks outages stock-race` | 100 contending physical checkouts for five units: five accepted, 95 stock conflicts after transparent retries; cancel released exactly five units. |
| `fulfillment-checks prepare-broker/run-broker/recover-broker`, RabbitMQ stopped, Commerce/Billing restarted | SQL-retained paid work/refund obligation survived delivery interruption; unknown return remained unconfirmed; restoration converged to one exact return with no failed-line effect. |
| `fulfillment-checks prepare-bank/run-bank/recover-bank`, Bank stopped for 45 seconds with owner restarts | Outstanding refund remained UNKNOWN; **five** real lookup attempts were recorded, demonstrating recovery beyond three attempts; restoration confirmed one return. |
| `recovery-checks redis-down`, Redis stopped and second Commerce worker running | Cache/overlap bypass retained SQL effect uniqueness, authenticated API and owner/admin boundaries; degraded quota visibly returned 429 after 120 invalid new requests. Temporary worker removed. |
| `submission-checks outages prepare-db/db-down/recover-db`, PostgreSQL stopped and owners restarted | Unsafe reads/new writes returned bounded 502/503; anonymous request remained 401. Original create key replayed the same order and completed with one grant; rejected key was absent from SQL. |
| `submission-checks outages prepare-identity/identity-warm/identity-cold/recover-identity` | Cached signed token worked with provider down; anonymous stayed 401; cold Gateway verifier returned 503 rather than authorizing; restoration accepted a freshly issued real token. |
| `powershell -NoProfile -File scripts/verification/durability.ps1` | Fresh secrets/setup rerun, migrations, seeds, all-three-type paid checkout and isolated restore passed. Four owner databases matched complete row fingerprints before writers started. Paid deferred 50-digit IRR order resumed once on target and original source. |
| `foundation-checks` after DB filter correction | Real OIDC/PKCE/role/ownership/header spoof checks, immutable snapshots, owner DB privileges, precise money, budget/stock constraints and bounded catalog all passed. |
| `recovery-checks` against rebuilt Gateway | Redis shared cache/quotas/lock, cancellation races, fifth-attempt recovery, durable cost review and audited manual cycle passed. |
| `submission-checks proxy-reuse` | 200 authenticated reads used one incoming socket; request after 6.5 seconds also succeeded. Rebuilt Gateway logs contained no timeout-listener warning during this check. |
| `submission-checks audit` after outages/restore | All original 313 load orders remained COMPLETED with one charge/grant/attempt and no live load slots. Global budget matched four retained slots out of 200, admission enabled. |

The full outage runner is `scripts/verification/failures.ps1`; this session executed its phases incrementally while correcting test/runtime issues. `-Remaining`, `-DatabaseOnly` and `-IdentityOnly` allow resuming selected phases. They are not a claim that one uninterrupted initial run passed. All runners deliberately interrupt local services: use a development environment, then verify source readiness afterward.

## Backup evidence

Run `20261107T114343-4cf3e8a4` created uniquely named clean/restore projects. Quiescent snapshot timestamp: 11:43:58 UTC. Both isolated proofs completed at 11:48:14 UTC, followed by original-stack restoration and successful deferred-order completion. This interval includes clean installation and provisioning; it is not an isolated restore RTO measurement.

| Database | Public tables matched | Rows matched |
|---|---:|---:|
| Commerce | 31 | 25,094 |
| Billing | 13 | 13,921 |
| Bank | 7 | 874 |
| Identity | 101 | 2,054 |

Archive checksums and length-delimited row SHA-256 fingerprints matched on a distinct PostgreSQL cluster. Owner runtime DDL/cross-database access and scoped broker permissions passed on fresh and restored stacks. The fresh three-type order totaled exactly 300 IRR and reached COMPLETED. Restored paid work retained the original 50-digit amount and one Bank/Billing operation. No original volume was overwritten; isolated test volumes are stopped and retained.

The broker reconstruction scan ran and found **zero missing durable inbox handoffs** in this particular snapshot. Its nonzero-gap branch was not exercised here; prior transport tests cover original-ID duplicate publication/deduplication. Backup/restore protects the stopped snapshot, not post-backup writes or host loss when archives remain on the same host. [Operational procedure and RPO/RTO limitations](OPERATIONS.md).

## Corrections made during verification

The load sampler originally used a nonexistent outbox timestamp; the first run completed its work but failed instrumentation. Its separate report was preserved, and the corrected measured run passed. Outage orchestration now forwards Docker arguments without PowerShell consuming `-d` as `-Debug`, waits for a restarted Gateway to listen, and keeps service restoration in `finally`. The legacy recovery client retries ambiguous transport failures with unchanged keys instead of assuming no acceptance.

A real PostgreSQL outage exposed native adapter DNS/socket errors returning 500. Commerce now maps temporary connection failures to 503/Retry-After while retaining existing HTTP and Prisma error handling. Repeated polling exposed proxy timeout listeners accumulating on a reused incoming socket. Gateway now uses a cleaned-up per-request six-second timer while retaining its five-second upstream timeout. The targeted reuse check and full recovery suite passed after that correction. The load measurements precede this timer correction; no post-correction sustainable-throughput claim is made.

## Scope and limitations

- All eight roadmap steps now have implementations and selected execution evidence. [VERIFICATION.md](VERIFICATION.md) remains the wider scenario plan; its rows are not blanket passing results.
- Component hard caps fit the 8 GiB/four-core server budget, but the physical Docker host was larger/shared. A dedicated-host benchmark, long mixed-workload soak, forced OOM/CPU exhaustion and genuine disk-full run were not performed. Low-storage signal/freshness checks were executed in [step 6](RECOVERY_VERIFICATION.md).
- Load measured digital orders with default successful Bank outcomes. Separate suites exercise typed effects, large exact amounts, returns and provider uncertainty. Saturated mixed refund/payment fairness, login/MFA throughput, broker queue age and accepted-only HTTP percentiles remain measurement work.
- Previous [desktop/mobile Persian UI evidence](UI_VERIFICATION.md) remains applicable; this step changed backend deadlines and documentation, not screens. Browser MFA and production TLS deployment are not claimed as newly verified.
- No real providers, HA, automatic disaster failover, encrypted off-host backups, point-in-time recovery, centralized alerting or production penetration test are provided. This is the documented simulator submission scope.

## Reviewer entry points

Start with [README](../README.md) and the [Persian demo](UI_GUIDE.md); then read [API reference](API.md), [request collection](../api/tops.http), [ownership diagram](SERVICE_ARCHITECTURE.md), [workflow/state diagrams](WORKFLOW_DIAGRAMS.md), [load evidence](LOAD_RESULTS.md) and [runbooks](OPERATIONS.md). Earlier milestone reports retain detailed deterministic crash/concurrency/financial assertions. Git integration uses scoped commits and an explicit local merge into `develop`; publication/release remains separate.
