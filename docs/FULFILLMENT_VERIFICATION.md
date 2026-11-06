# Step-5 verification — 2026-11-06

Feature: `feature/fulfillment-refund-workflows` from `develop`. This report concerns local typed effects, order aggregates, whole-line refunds and their recovery; it does not claim real carrier/provider integration or completed UI/public review actions.

## Reproduction

Use the README bootstrap, forward migrations and Compose startup, then:

```sh
docker compose --profile tools run --rm --build fulfillment-checks
docker compose --profile tools run --rm --build tools npm test
docker compose --profile tools run --rm --build foundation-checks
docker compose --profile tools run --rm --build checkout-checks
docker compose --profile tools run --rm --build payment-checks
```

Optional multi-worker run: create a temporary `docker compose run -d --no-deps --name tops-fulfillment-check-replica commerce`, then run fulfillment-checks with `-e FULFILLMENT_SECOND_ORIGIN=http://tops-fulfillment-check-replica:3000`. The suite waits for the second worker; both process the shared SQL queue. Remove only that named test replica afterwards. Its temporary 640 MiB/0.60-core cap is not an additional steady service or an 8 GB/4-core throughput benchmark.

Outage reproduction (always restore the dependency in a finally block if a command fails):

```sh
docker compose --profile tools run --rm fulfillment-checks prepare-bank
docker compose stop bank-simulator
docker compose --profile tools run --rm fulfillment-checks run-bank
docker compose restart commerce billing
docker compose up -d --no-deps --wait --wait-timeout 120 bank-simulator
docker compose --profile tools run --rm fulfillment-checks recover-bank

docker compose --profile tools run --rm fulfillment-checks prepare-broker
docker compose stop rabbitmq
docker compose --profile tools run --rm fulfillment-checks run-broker
docker compose restart commerce billing
docker compose up -d --no-deps --wait --wait-timeout 120 rabbitmq
docker compose --profile tools run --rm fulfillment-checks recover-broker
```

## Executed results

| Check | Executed result |
|---|---|
| Generated clients / TypeScript / Prisma validation | Passed |
| Unit suite | 11 passed |
| Earlier foundation, checkout and payment integration suites | Passed with step-5 processing enabled; payment fixtures defer only their own pre-cutoff jobs and release those deferrals afterwards |
| Digital/subscription/physical completion | One grant, extension and shipment; all payable items succeeded before COMPLETED; allocated stock consumed without another decrement |
| Duplicate local jobs | Existing successes stayed successful; effect counts and stock remained unchanged |
| Concurrent renewal | Two fixed paid 30-day snapshots added exactly 60 days to future expiry despite a later 90-day catalog edit |
| Transient failure | Post-effect failure rolled back entitlement/grant, persisted a real 10–12 second retry and completed on attempt two |
| Stock discrepancy / admin action | Worker paused without a business attempt; admin role/generation/reason/idempotency enforced; successful line retained |
| 100 paid / failed 50 | Exactly 50 returned once; PARTIALLY_REFUNDED, no failed-line shipment, no missing-stock relisting and RESOLVED rather than COMPLETED |
| Two full failed lines | Two concurrent returns summed to captured 100, with rolled-back shipments and valid stock release once; REFUNDED/RESOLVED |
| Unknown return | Lost response did not count as returned money; stable-key lookup confirmed the original return |
| Timeout before return | Original pending operation succeeded on the next idempotent execution; one operation/return |
| Provider decline | REVIEW_REQUIRED, owed money/admission retained and OPEN review case; no fabricated return/completion |
| Logs / replay | Owner-scoped paged logs retained; duplicate/reverse status delivery preserved effect counts and totals; changed amount quarantined |
| Zero amount | Failed free line settled without a Bank refund or invented refunded amount |
| Storage guards | Wrong typed effects, success after refund disposition and invalid captured-line total rejected; Bank over-return and customer caller rejected |
| Fulfillment cutoff | Accepted pre-start intent prevented effects and refunded; post-start intent rejected against immutable first-start time |
| Computed-work admission | Oversized server snapshot rejected with 413 and no key/slot leak; 60,000-digit single-line IRR round-tripped exactly |
| Two Commerce workers | Same shared-queue fulfillment/refund suite passed; temporary replica removed afterwards |
| Bank outage + owner restart | Accepted return remained owed/unconfirmed, then one exact 60-digit return settled after restoration |
| Broker outage + owner restart | Committed disposition/outbox survived and later delivered one return, without re-running effects |
| Migration rerun | Commerce 10, Billing 8, Bank 6 migrations; no pending migrations or reset/checksum edits |
| Formatting / isolation / dependency audit | Formatting and original DB/broker/Redis smoke passed; production build audit reported zero vulnerabilities |
| Admission reconciliation | Counter matched durable live slots; unresolved declined-return fixtures stayed counted |

Observed steady memory after final checks (MiB): Commerce 149.90, Billing 90.02, Bank 95.92, Gateway 62.21, Identity 609.20, PostgreSQL 102.60, RabbitMQ 88.79, Redis 6.31. Configured caps remain 5824 MiB/3.30 cores. These are development-host observations, not a sustained throughput measurement.

## Fixture and measurement limits

Tests create identified products/orders. Private SQL rules defer only test items, inject a failure after effect writes, or choose a Bank refund outcome. Tests wait for an actual 10–12 second first retry; some financial due times are advanced after observing UNKNOWN to keep checks bounded. No customer force-state/fault API exists. Queue-binding changes are restored in finally blocks; only the named temporary worker is removed.

SQL rejection checks roll back. Completed ledgers/history/effects remain. Products are deactivated through admin APIs. The definitive-refund-decline fixture deliberately retains owed money, an OPEN review case and its admission slot; verification does not reset that debt to report an empty backlog. Earlier payment checks defer their own jobs to inspect pre-fulfillment boundaries, then release those private deferrals so accepted workflows can settle normally.

The effect tables' operational foreign keys and checks are declared in forward SQL; their scalar Prisma models support the owner-local store. Do not use automatic schema push/reset to erase custom guards. Migrations are additive and applied checksums are retained.

Worker limits and pools remain within the planned steady resource envelope. Disk/backup durability, sustained offered/admitted/drained throughput, exhaustive kill-point injection, public cancellation/retry/review actions, cost-aware circuits/priority lanes and the three Redis features remain later verification/milestones. No unmeasured RPS or fully completed product is claimed.
