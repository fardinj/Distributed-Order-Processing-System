# Service skeleton verification — 2026-11-06

Scope: roadmap step 1 only. Service boot, resource configuration, local credentials, health, data/network ownership and broker transport. Business schemas/migrations, outbox persistence, charging/refunds, API authorization/session integration and Persian UI have not been implemented or tested.

## Reproduce

```sh
docker compose --profile setup run --rm --no-deps setup
docker compose config --quiet
docker compose up --build --wait --wait-timeout 360
docker compose --profile tools run --rm --build tools npm test
docker compose --profile tools run --rm tools npm run validate:schemas
docker compose --profile tools run --rm tools npm run format:check
docker compose --profile tools run --rm tools
docker compose stats --no-stream
```

Run setup before the first start. Do not remove existing volumes/secrets to repeat a check. Tools are temporary and have a separate memory budget from the steady runtime.

## Executed results

| Check | Actual result |
|---|---|
| Root and optional dev Compose validation | Passed |
| Node/TypeScript/NestJS image build | All four service images compiled and booted |
| Prisma 7.10.1 schema validation | All three intentionally empty service schemas valid; no domain migration implied |
| Unit checks | 4 passed: optional Redis readiness, required dependency failure, correlation-ID validation, Identity path restrictions |
| Current source formatting | Passed |
| Runtime npm audit | 0 reported vulnerabilities with `--omit=dev`; not an image/OS security audit |
| Initial Compose readiness | All eight services healthy |
| Gateway/OIDC discovery | Application realm reachable with configured public issuer; correlation header preserved |
| Closed paths | Admin/master/management Identity paths and unfinished order API return 404 through gateway |
| PostgreSQL runtime ownership | Commerce/Billing/Bank can access own database, have no superuser status, cannot create tables and cannot connect to a foreign owner database |
| RabbitMQ ownership/transport | Publisher confirm + cross-owner routed delivery/ack passed; foreign topology configuration denied |
| Broker users | Only Commerce, Billing and generated-password administrator accounts; no guest account |
| Authenticated Redis | PING passed |
| Redis stop/outage | Complete integration check passed with Redis stopped; gateway/Commerce returned HTTP 200 with explicit `degraded` and Redis down |
| Redis restore | Redis healthy again and full normal smoke passed; project left running |
| Resource/network contract | Steady service limits total 5824 MiB and 3.30 CPU cores; only gateway has a published port; application network is internal |

The tool helper initially failed TypeScript compilation at its default heap inside a 512 MiB container. Corrected it to a temporary 1024 MiB cap / 768 MiB Node heap, reran compilation/unit checks successfully. Steady service budgets were unaffected.

Keycloak database readiness requires metrics enabled; its private health endpoint is configured accordingly ([Keycloak health checks](https://www.keycloak.org/observability/health)). The final smoke additionally asserts the database check is present. Metrics/management routes remain outside the gateway allowlist.

## Post-smoke resource snapshot

Measured with `docker compose stats --no-stream` after normal smoke/recovery. This is a single post-smoke observation on nearly empty databases, not sustained idle or production-load capacity.

| Service | Observed memory MiB | Configured limit MiB |
|---|---:|---:|
| Gateway | 53.79 | 192 |
| Commerce | 42.50 | 640 |
| Billing | 40.55 | 384 |
| Bank simulator | 40.54 | 192 |
| Identity | 607.00 | 2048 |
| PostgreSQL | 79.32 | 1536 |
| RabbitMQ | 169.40 | 640 |
| Redis | 6.04 | 192 |
| Total, approximately | 1039.64 | 5824 |

Container CPU ceilings sum to 3.30 cores and memory caps to 5824 MiB, fitting the planned 8 GiB/4-core service envelope with headroom. Docker Desktop itself reported 20 logical CPUs and about 15.4 GiB available, so this is not a benchmark on a physically isolated 4-core/8-GB machine. Other projects were already running and were not stopped or reconfigured.

## Storage and durability assumptions

Local Docker named volumes persist PostgreSQL/RabbitMQ across normal container restarts and `compose down`. This is one developer host, not HA or guaranteed disaster recovery. Redis is deliberately nonpersistent auxiliary state. The measured PostgreSQL-volume backing filesystem reported about 948 GiB available; that is host free space, not a reserved project quota.

No automatic backup/restore workflow or storage admission watermark has been implemented. Record/test them before admitting real business data. Credential files and broker definitions are excluded from Git/images, and changing them alone does not rotate credentials stored in initialized volumes.

## Remaining roadmap work

Step 2 supplies business migrations/exact-NUMERIC adapters, application identity/session integration and authenticated admin APIs. Step 3 adds durable outbox/inbox workflow persistence. Later milestones implement stock/payment/refunds/retry/admission behavior and UI. Broker smoke is transport evidence, not exactly-once effects or a completed transactional outbox implementation.
