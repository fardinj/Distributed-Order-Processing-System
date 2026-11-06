# Step-2 foundation verification — 2026-11-06

Scope: owner migrations, exact IRR, OIDC/API permissions, catalog/admin inventory and protected snapshot reads. This is not checkout, fulfillment or payment-worker evidence.

Work branch: `feature/domain-identity-admin-foundations`, based on `develop`; `main` remains release history. See GIT_WORKFLOW.md.

## Reproduction

```sh
docker compose --profile setup run --rm --no-deps setup
docker compose up -d --wait postgres rabbitmq redis identity
docker compose --profile bootstrap run --rm --build migrate
docker compose --profile bootstrap run --rm identity-init --fixtures
docker compose --profile bootstrap run --rm --build seed
docker compose up --build --wait --wait-timeout 360
docker compose --profile tools run --rm --build tools npm test
docker compose --profile tools run --rm --build foundation-checks
```

Bootstrap is additive/idempotent. Never reset existing volumes/secrets for a rerun. Production runtimes receive no migration/master credentials. Development fixture clients obtain real signed provider tokens without printing them; this is not a browser login/MFA demonstration.

## Executed results

| Scenario | Result |
|---|---|
| Generated clients / TypeScript build | Passed for all services |
| Owner migrations | Foundation + custom CHECK/index/trigger guards deployed to Commerce, Billing and Bank; completion checked in each migration table |
| Unit tests | 8 passed: readiness, correlation/proxy policy, exact money/canonical fingerprints and real signed JWT invalid-claim rejection |
| Real OIDC access | Customer/admin/service claims verified with provider JWKS; issuer/audience/expiry/type checks active |
| API authorization | Anonymous/forged requests denied; role/identity header spoof denied; customer denied admin endpoints even on direct internal service access |
| Service identity | Authenticated private service diagnostic works; gateway does not route internal diagnostics |
| PKCE | Plain challenge rejected via OAuth error redirect; S256 configured; no end-user password grant enabled |
| Large IRR | 60-digit values round-trip through Commerce Prisma transactions and API unchanged; Billing/Bank charge/refund columns preserve exact decimal strings |
| Numeric model | Owner money columns report no declared precision; fractions/nonfinite/negative values rejected by SQL/application guards |
| Admin idempotency | Same key/request replays original result; changed payload conflicts |
| Paid snapshots / ownership | Owner can read, second customer gets 404; catalog changes do not mutate paid item snapshots; direct snapshot rewrite rejected |
| Stock concurrency | Competing updates with same expected version give one success/one conflict; over-subtraction rejected |
| Warehouse discrepancy | Holds preserved, sellable stock zero, count/affected-hold evidence and audit/review recorded |
| Refund budget race | Two simultaneous 60-unit refunds against captured 100 produce one success/one SQL rejection |
| Bank result/identity | Terminal charge result and refund monetary identity cannot be rewritten |
| Migration history | Runtime roles cannot read/write the owner's migration metadata |
| Product deactivation / paging | Inactive product hidden from customer, retained for admin; limits/cursors validated |

The migration authoring command initially omitted explicit Prisma 7 datasource config and returned no SQL. It was diagnosed before deployment, corrected, and the unnecessary engine workaround was removed. All committed migrations are nonempty, versioned and forward-only; no deployed migration checksum was edited.

## Final checks

All four migrations per owner are applied; a second deploy reports no pending migrations. Foundation integration checks, eight unit tests, TypeScript/client build, formatting and the original stack isolation/transport smoke checks pass. Runtime dependency audit reports zero vulnerabilities (`npm audit --omit=dev --audit-level=high`).

With Redis stopped, authenticated admin requests still succeeded, customer/anonymous admin access remained denied, and readiness reported degradation. Redis was restored and the stack smoke checks passed afterwards. Runtime roles cannot delete durable order/payment/bank evidence; SQL rejects NULL subscription duration and nonphysical stock/reservations.

Idle resource snapshot (MiB): Gateway 64.12, Commerce 88.29, Billing 54.72, Bank 44.05, Identity 598.30, PostgreSQL 76.81, RabbitMQ 137.30, Redis 6.04. These are observations on the development host with configured caps, not an 8 GB/4-core load benchmark. No throughput or completed browser-login/MFA result is claimed.

## Test data and operational limits

SQL financial fixtures roll back; explicitly created order/item/reservation fixtures are removed by their known IDs. Test products are deactivated through the admin API, preserving their audit/discrepancy evidence. Tests never clear other data. Stock shortages leave a review case rather than selecting a losing customer automatically.

Migration/seed/verification containers are temporary and have their own memory caps. Domain SQL uses separate runtime pools (Commerce up to seven Prisma connections plus one health slot) within the planned aggregate pool budget. The eight steady runtime caps remain the initial 5824 MiB/3.30-core envelope; workload capacity is unmeasured.

Outbox schema and mutation events exist, but publication/idempotent business-consumer processing is step 3. Current auth uses stateless access-token checks and provider-owned sessions; the browser callback/Persian UI is later. Access revocation is bounded by the five-minute token lifetime, not claimed immediate.
