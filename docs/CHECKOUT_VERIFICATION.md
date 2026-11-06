# Step-3 verification — 2026-11-06

Work branch: `feature/checkout-admission-outbox` from `develop`. Scope is checkout/admission and reliable owner-local preparation; payment execution and Persian UI are not implemented in this milestone.

## Reproduction

After the README bootstrap/migration/start sequence:

```sh
docker compose --profile tools run --rm --build tools npm test
docker compose --profile tools run --rm --build foundation-checks
docker compose --profile tools run --rm --build checkout-checks
```

Optional two-Commerce check: start a temporary `docker compose run -d --no-deps --name tops-commerce-check-replica commerce`, then run checkout-checks with `-e CHECKOUT_SECOND_ORIGIN=http://tops-commerce-check-replica:3000`. The script waits for the replica and alternates create calls between it and the gateway. Remove only this named temporary replica afterwards. This adds a temporary 640 MiB/0.60-core cap during verification; it is not a new steady service or production load benchmark.

Broker outage/restart scenario (always restore the broker if a check fails):

```sh
docker compose stop rabbitmq
docker compose --profile tools run --rm checkout-checks outage-create
docker compose restart commerce billing
docker compose up -d --no-deps --wait --wait-timeout 120 rabbitmq
docker compose --profile tools run --rm checkout-checks outage-recover
```

The fixture stores IDs/key, never tokens, in ignored `.local/verification/checkout-outage.json`. It creates stock and an accepted order with the broker absent, then checks recovery of that identity across owner restarts. Apply the original key after ambiguous responses; never clear live state.

## Executed results

Tests use real OIDC tokens, PostgreSQL row locks and RabbitMQ delivery; no mock proves the concurrency results.

| Check | Executed result |
|---|---|
| Client generation, TypeScript, Prisma schema validation | Passed |
| Unit tests | 10 passed |
| Existing foundation and service isolation/transport suites | Passed |
| 50 simultaneous creates, canonical duplicate lines | All replayed one order with exact total and one slot/hold generation |
| Two Commerce instances | Same create/replay, last-unit, expiry/admission and recovery suite passed across both processes |
| Input/owner guards | Client price/status fields rejected; nonphysical duplicates rejected; nonowner detail/refresh denied; exact cursor pagination does not repeat the prior record |
| Failed allocation | Key/order/slot/stock changes rolled back; last unit had one winner |
| Expiry/reacquisition | Released once, replay stayed expired; changed stock produced revision 2 requiring confirmation; stale revision rejected; active refresh did not extend expiry |
| Repeat confirmation | One confirmation event, unchanged timer |
| SQL admission | Full/paused budget rejected new work with 503/Retry-After; existing replay succeeded; counter matched live slots |
| Cross-owner preparation | Billing received exact snapshot; Commerce acknowledgment advanced source version; no payment or bank charge created |
| Duplicate/out-of-order/conflicting/poison delivery | Receipt/effect applied once; stale revision could not regress projection; conflict/unsupported input quarantined |
| Publisher recovery | Unroutable mandatory publication stayed unpublished and recovered after binding restoration; expired claim republished safely |
| Transient handler failure | Row-lock timeout rolled back effects/receipt, persisted delayed retry and completed after lock release |
| Durable inbox capacity | Synthetic future-due fixtures filled 10,000 pending slots; new envelope remained in the broker without SQL staging/ACK, then completed when capacity returned |
| Broker outage and owner restart | Checkout/stock/slot/outbox committed with broker stopped; Commerce/Billing restarted; restoration drained preparation once; replay retained identity and expiry; no payment created |
| Payment-owned expiry boundary | SQL fixture PAYMENT_PENDING hold was not released by stale checkout expiry |
| Admin shortage expiry | Zero quarantined sellable stock stayed zero rather than relisting missing units |
| Migration rerun | Commerce/Billing five migrations, Bank four; no pending migrations; existing SQL checksums retained |
| Formatting / runtime dependency audit | Formatting passed; production build audit reported zero vulnerabilities |

Observed service memory after checks (MiB): Commerce 150.20, Billing 77.34, Gateway 59.29, Bank 43.89, Identity 601.80, PostgreSQL 92.06, RabbitMQ 166.80, Redis 6.06. Steady caps remain 5824 MiB/3.30 cores. These observations are on the development host; no sustained 8 GB/4-core throughput claim is made.

## Fixture and evidence limits

Known test checkouts are made due using migrator-only SQL so expiry tests do not sleep five minutes. Tests wait for ordinary runtime expiry/slot release and deactivate their own products, retaining revisions/history/discrepancies. The payment-owned hold boundary is a known SQL fixture, not proof of a working payment-entry API. Financial operations remain absent for prepared checkouts. No volume reset or unrelated data deletion occurs.

The transport checks temporarily remove/restore the Billing queue binding to exercise mandatory returns, replay a published message, inject identified poison/conflict fixtures, and leave one publisher lease for expiry recovery. The lock retry test holds a single prepared checkout row, observes a durable delayed retry, then releases the lock. The inbox-capacity test inserts synthetic future-due rows under a unique test consumer name and removes only those synthetic rows afterwards. These are focused failure checks, not exhaustive kill-at-every-instruction or disk-loss durability tests. Disk reserve, backup/restore, host load and sustained admission/drain measurements remain step 8; priority financial lanes expand with their workflows.
