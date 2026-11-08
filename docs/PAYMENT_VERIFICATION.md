# Step-4 payment verification — 2026-11-06

Feature branch: `feature/payment-stock-bank-recovery` from `develop`. Tests use real OIDC, owner-local PostgreSQL and RabbitMQ plus the Bank HTTP API. No real money or external bank is involved.

## Reproduction

After the README setup/migrations/start sequence:

```sh
docker compose --profile tools run --rm --build payment-checks
docker compose --profile tools run --rm --build tools npm test
docker compose --profile tools run --rm --build foundation-checks
docker compose --profile tools run --rm --build checkout-checks
```

Outage phases store only known fixture IDs in ignored `.local/verification/`. Always restore the stopped dependency, including after a failed check.

```sh
docker compose stop bank-simulator
docker compose --profile tools run --rm payment-checks bank-outage-create
docker compose restart billing commerce
docker compose up -d --no-deps --wait --wait-timeout 120 bank-simulator
docker compose --profile tools run --rm payment-checks bank-outage-recover

docker compose stop rabbitmq
docker compose --profile tools run --rm payment-checks broker-outage-create
docker compose restart billing commerce
docker compose up -d --no-deps --wait --wait-timeout 120 rabbitmq
docker compose --profile tools run --rm payment-checks broker-outage-recover
```

## Executed results

| Check | Executed result |
|---|---|
| Client generation, TypeScript and Prisma validation | Passed for all owners |
| Unit suite | 11 passed |
| Existing foundation and checkout suites | Passed, including original stock/refund guards and bounded inbox backpressure |
| Service isolation/transport smoke | Passed: private DB roles, broker permissions/confirms/ack, authenticated Redis and readiness |
| Auth/ownership | Nonowner payment denied; customer and Commerce service denied Bank charge API; internal charge routes not proxied; forged amount fields rejected |
| Concurrent payment entry | 20 requests produced one stable payment identity, exact large-IRR charge, allocation and fulfillment job |
| Definite decline | Stock and admission released once; repeated entry did not create a replacement operation |
| Timeout after charge | Bank committed success, Commerce saw UNKNOWN, then reconciliation recovered that same success without another charge |
| Timeout before charge | Stock remained PAYMENT_PENDING with a due checkout timestamp; more than three scheduled attempts retained increasing delay and pending recovery |
| Abandoned claim | Active lease prevented overlap; expired payment lease recovered with the original Bank key |
| Bank deadline | Stored interval exactly 900 seconds; due pending operation failed and could not later charge; past-deadline committed success stayed successful |
| Expired gateway entry | Unchanged basket reacquired/promoted atomically; changed stock produced a new unconfirmed revision and no payment until confirmation |
| Result delivery | Duplicate/stale versions could not regress paid state or duplicate jobs; mismatched amount quarantined |
| Cancel before original command | Billing and Bank tombstones fenced delayed payment; no-charge result released once; direct late Bank init/execute stayed FAILED |
| Unknown/charged cancellation | Unknown released only after Bank fence; charged success remained SUCCEEDED with REFUND_REQUIRED, allocated stock/admission and suppressed ready jobs |
| Bank outage + owner restarts | Entry retained stock and UNKNOWN recovery; restoration reconciled one charge/result/allocation/job |
| Broker outage + owner restarts | Entry committed SQL command and payment-owned stock; restored broker delivered one financial workflow |
| Migration rerun | Commerce 7, Billing 6, Bank 5 migrations; no pending migrations, no reset or applied-checksum edits |
| Formatting / production dependency audit | Formatting passed; production build audit reported zero vulnerabilities |
| Admission reconciliation | Counter matched 15 active slots after verification; paid/unsettled fixtures remained counted rather than discarded |

Observed steady service memory after checks (MiB): Commerce 144.60, Billing 80.89, Bank 73.95, Gateway 70.69, Identity 603.80, PostgreSQL 92.74, RabbitMQ 87.93, Redis 6.30. Configured totals remain 5824 MiB/3.30 cores. Bank uses one domain connection plus one health slot inside its existing two-slot budget. These observations are not a sustained host-capacity benchmark.

## Evidence boundaries

Near-deadline fixtures are inserted with an original Bank initialization time almost 15 minutes in the past; the schema still enforces exactly 900 seconds. This tests real runtime deadline finalization without waiting 15 minutes. Existing operation clocks/outcomes are not edited to pass checks. Checkout timer fixtures use migrator-only SQL; unknown holds remain protected with a due old checkout timestamp. A two-second abandoned claim tests payment lease recovery. Outage restarts test persisted recovery state; they do not prove every possible kill-at-each-instruction/disk-loss boundary.

Cancellation tests inject an identified Commerce intent/command through controlled SQL and temporarily restore/remove a queue binding to control original-command delivery. This proves the internal no-charge protocol and charged-result suppression, not a public cancellation API or refund implementation. No refunded amount is fabricated.

Test products are deactivated and unpaid checkout fixtures are made due. Paid ledgers, ALLOCATED stock, pending refund intents, history, tombstones and fulfillment jobs remain as evidence. Their admission slots intentionally remain until steps 5/6 settle accepted work. Tests never delete accepted financial work, reset volumes or zero capacity counters. Repeated suites therefore consume real unfinished-work capacity; run the later processors to settle those fixtures rather than discarding them.

Fulfillment jobs are dispatched durably but not executed yet. Refund execution, public cancellation, Persian UI, sustained 8 GB/4-core throughput, disk alarms, backup/restore and exhaustive crash injection remain later milestones. Current resource caps and pool budgets are retained; no measured RPS is claimed.
