# TOPS — distributed order processing

Docker-first NestJS/TypeScript workspace. Steps 1–2 provide service infrastructure, owner-local schemas, exact IRR, OIDC-protected catalog/admin APIs and owner-protected order reads. Checkout/payment/refund workers, outbox delivery and the Persian UI are subsequent milestones.

## Start or upgrade

Docker with Compose is sufficient; host Node/npm is optional. Run from this directory:

```sh
docker compose --profile setup run --rm --no-deps setup
docker compose up -d --wait postgres rabbitmq redis identity
docker compose --profile bootstrap run --rm --build migrate
docker compose --profile bootstrap run --rm identity-init --fixtures
docker compose --profile bootstrap run --rm --build seed
docker compose up --build --wait --wait-timeout 360
docker compose --profile tools run --rm --build tools
docker compose --profile tools run --rm --build foundation-checks
```

Setup creates `.env`, random passwords and hashed broker definitions in gitignored `.local/`. It preserves existing credentials; rerun when new secret names are introduced. Start infrastructure and apply migrations before domain apps: readiness now checks that each owner's schema exists.

Migration/seed commands are additive and idempotent. `identity-init --fixtures` explicitly installs local demo users and separate machine test clients; omit that flag for nonfixture provisioning. It prints no password/token. Human demo admin requires TOTP setup. Never reset data or delete volumes to make a check pass.

Open [status](http://localhost:8080), [readiness](http://localhost:8080/health/ready), [auth configuration](http://localhost:8080/auth/config) or [OIDC discovery](http://localhost:8080/identity/realms/tops/.well-known/openid-configuration). Protected routes require bearer access tokens. Port/public origin are in `.env`; change both together and rerun identity provisioning for the exact callback origin.

## Find the code

```text
apps/
  gateway/src/           # JWT verification and allowlisted client proxies
  commerce/
    src/modules/catalog # Products, audited/versioned inventory administration
    src/modules/orders  # Owner-protected snapshot reads
    prisma/             # Owned schema and versioned custom SQL migrations
  billing/prisma/       # Payment/refund ledger foundation and guards
  bank-simulator/prisma/# Independently committed provider-ledger foundation
packages/runtime/src/   # Bootstrap, health, JWT/service identity, exact IRR helpers
infrastructure/
  docker/Dockerfile     # Multistage build; selected app only in runtime image
  postgres/init/        # Isolated runtime/migration roles and databases
  rabbitmq/             # Broker config; definitions generated locally
  redis/                # Authenticated auxiliary store
  keycloak/             # Provider bootstrap, realm and health
scripts/                # Setup, migrate, identity provision, seed, smoke checks
tests/                  # Readiness, signed JWT, exact money and fingerprint checks
docs/                   # Decisions, design, API, workflow and verification
compose.yaml            # Normal stack and opt-in bootstrap/tool profiles
compose.dev.yaml        # Optional loopback-only diagnostic ports
```

Root npm workspaces share exact dependency versions and `package-lock.json`; apps own their source/schema. Shared runtime contains technical utilities, not shared order/payment models. Each app has its own README. Generated clients are ignored and rebuilt inside images.

## Services and limits

| Service | Internal address | Memory cap | CPU ceiling |
|---|---|---:|---:|
| Gateway | gateway:3000 | 192 MiB | 0.20 |
| Commerce | commerce:3000 | 640 MiB | 0.60 |
| Billing | billing:3000 | 384 MiB | 0.30 |
| Bank simulator | bank-simulator:3000 | 192 MiB | 0.10 |
| PostgreSQL | postgres:5432 | 1536 MiB | 1.00 |
| RabbitMQ | rabbitmq:5672 | 640 MiB | 0.40 |
| Redis | redis:6379 | 192 MiB | 0.10 |
| Identity | identity:8080, health :9000 | 2048 MiB | 0.60 |
| **Steady total** | | **5824 MiB** | **3.30** |

Only gateway publishes `127.0.0.1:8080`; the application network is private/internal. Remaining headroom in the 8-GiB/4-core plan covers OS/telemetry. Temporary build/migration/check containers have separate caps; keep heavy tooling outside runtime benchmarks. These configured caps are not sustainable-throughput evidence.

```sh
docker compose ps
docker compose logs --tail 100 commerce
docker compose stats --no-stream
docker compose down
```

`down` retains PostgreSQL/RabbitMQ named volumes. Do not remove `.local/` or volumes just to restart. Initializers/realm import are first-start bootstrap, not credential rotation. This is one local developer host, not HA or a proven disaster-recovery setup.

## Identity and ownership

Keycloak owns users/sessions and refresh rotation. `tops-web` is a public Authorization Code/S256 PKCE client; `tops-api` is the access-token audience. Gateway and domain APIs independently check signature, issuer, audience, expiry, token type, subject and roles. Internal service identities cannot use customer/admin permissions. Client identity/role headers are not trusted.

Identity admin/master/management routes remain private. Bootstrap credentials and fixture secrets are mounted only into provisioning/check containers; app runtimes never receive master/migrator credentials. The callback/Persian UI is later; this milestone exposes authenticated APIs and provider configuration, not a finished browser session UI. Stateless access revocation is bounded by the five-minute access-token lifetime. Local HTTP is loopback development configuration; do not expose it directly to the internet.

PostgreSQL has separate Commerce, Billing, Bank and Identity databases. Runtime roles cannot create tables or connect across owners; migrators own their schemas. Identity owns only its managed provider DB. Commerce's Prisma transactions and parameterized raw-money SQL use up to seven domain connections plus one health slot. Runtime history/audit is append-only; migration metadata is not writable by runtimes.

Money is whole IRR: canonical strings externally, exact BigInt arithmetic, unconstrained NUMERIC with finite/integer checks. No business monetary ceiling or Number conversion. Custom checks/triggers/partial indexes live in forward SQL migrations. Never edit applied SQL or use `db push`/reset to bypass migration history. Migration commands receive explicit owner config and verify completed history.

RabbitMQ accounts/exchanges/queue permissions are scoped by owner. Transport smoke proves confirms/routing/ack, not exactly-once business effects. Outbox tables/admin events now persist; publication/consumer recovery is step 3. Redis loss degrades readiness without bypassing auth/SQL rules; actual cache/overlap-lock/rate-limit features arrive in their roadmap step.

## Checks

```sh
docker compose config --quiet
docker compose --profile tools run --rm --build tools npm test
docker compose --profile tools run --rm --build tools npm run validate:schemas
docker compose --profile tools run --rm --build tools npm run format:check
docker compose --profile tools run --rm --build tools
docker compose --profile tools run --rm --build foundation-checks
```

Foundation checks use real OIDC principals, huge money, concurrent admin/refund changes and SQL guards. They create/deactivate their own test products and roll back/remove only known test-ledger fixtures, retaining audit/discrepancy evidence. No other data is cleared. Seeds preserve later admin edits; user passwords are set on first creation rather than silently reset on reruns.

With Node 24 locally: `npm ci`, `npm test`, `npm run format`. Keep version/lock changes together. Container builds generate the three private clients; Prettier ignores generated code. `scripts/toolchain-info.mjs` is an optional metadata helper, not an automatic updater.

Optional diagnostics:

```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --wait
```

This adds loopback PostgreSQL `15432`, RabbitMQ management `15672` and Redis `16379`; credentials are still required. Normal traffic uses private service DNS. Local Compose secrets are files under a private directory, not an encrypted production vault; changing files alone does not rotate initialized DB/broker credentials.

## Workflow and next step

Use `develop` for integration and `feature/*`/`fix/*` branches for changes; `main` stays release history. See [Git workflow](docs/GIT_WORKFLOW.md).

Next is [roadmap step 3](docs/ROADMAP.md): safe order admission/checkout, durable outbox publication and idempotent business consumers. Review [foundation API](docs/API_FOUNDATIONS.md), [design](docs/SYSTEM_DESIGN.md), [security](docs/SECURITY.md) and [capacity](docs/CAPACITY_AND_SCALING.md). Executed evidence is separated into [step 1](docs/SKELETON_VERIFICATION.md) and [step 2](docs/FOUNDATIONS_VERIFICATION.md).
