# Distributed Order Processing System

This project accepts orders and processes their items in the background. An order can contain digital products, subscriptions and physical products. Each type has its own processor.

The main goal is to keep orders, stock and payments correct when requests are repeated, workers stop or a dependency is unavailable. There is also a small Persian UI so the customer and admin flows are easy to try.

## What is included

- Product management and physical inventory with an audit trail.
- Idempotent checkout, a five-minute stock reservation and confirmation when the basket changes.
- A bank simulator with successful, failed and unknown payment outcomes.
- Separate digital, subscription and physical fulfillment modules.
- Item retries, manual review, cancellation and full or partial refunds.
- Order status/date filters, paginated event history and refund logs.
- Authentication, customer ownership checks and admin-only actions.
- Docker Compose, migrations, seeds and checks using the real databases and broker.

The stack is **Node.js, TypeScript, NestJS, Prisma, PostgreSQL, RabbitMQ and Redis**. Keycloak handles login and service identities. The repository uses npm workspaces and a shared lockfile.

## Run locally

You need Docker with Compose. A local Node installation is optional. Run these commands from the repository root:

```sh
docker compose --profile setup run --rm --no-deps setup
docker compose up -d --wait postgres rabbitmq redis identity
docker compose --profile bootstrap run --rm --build migrate
docker compose --profile bootstrap run --rm identity-init --fixtures
docker compose --profile bootstrap run --rm --build seed
docker compose up -d --build --wait --wait-timeout 360
```

Open **http://localhost:8080/**. Readiness is at http://localhost:8080/health/ready.

Setup creates `.env` and random credentials under `.local/`. Rerunning setup preserves existing credentials, and migrations/seeds preserve existing data. Keep `.local/` and the Docker volumes when restarting. The storage monitor needs three healthy samples before accepting new orders, which can take about 15 seconds after startup.

For later updates, apply migrations before starting the updated application images. Changing a credential file does not rotate a password already stored in PostgreSQL, RabbitMQ or Keycloak.

## Try the flows

The `--fixtures` option creates these local demo accounts:

| User | Username | Local password file |
|---|---|---|
| Customer A | `demo-customer-a` | `.local/secrets/user_customer_a_password` |
| Customer B | `demo-customer-b` | `.local/secrets/user_customer_b_password` |
| Admin | `demo-admin` | `.local/secrets/user_admin_password` |

Read the passwords from your own files. Admin login requires TOTP enrollment when first requested. These are development accounts, not production defaults.

Start by creating products and adding physical stock as admin. Then sign in as a customer, create a checkout, confirm payment and inspect the item results. Use separate browser profiles for the admin and customer if you want to switch between them. The [UI guide](docs/UI_GUIDE.md) covers the remaining flows.

The bank and shipments are simulated. Normal payments succeed; failure scenarios use private test fixtures rather than customer-controlled success/failure flags.

## How it is split

```text
apps/gateway/          Client entry point and Persian UI
apps/commerce/         Catalog, inventory, orders and typed fulfillment
apps/billing/          Payments, refunds and financial reconciliation
apps/bank-simulator/   Simulated bank and its own durable ledger
packages/runtime/     Shared technical code, without shared domain models
infrastructure/       Dockerfiles and infrastructure configuration
scripts/              Setup, migrations, seeds and verification runners
tests/                Unit and contract checks
docs/                 Decisions, design, API contracts and test results
```

Only the Gateway is exposed, on loopback port 8080. Commerce, Billing, Bank and Identity have separate databases and credentials on one private network. The product processors stay inside Commerce so their effects, stock changes and order state can commit in one SQL transaction.

PostgreSQL is the source of truth. RabbitMQ carries commands/results through owner-local outbox/inbox tables. Redis provides cache, scheduler overlap locks and rate limiting. If Redis fails, the API uses weaker per-instance rate limits while database safeguards and authentication remain active.

Money is whole **IRR**, carried as decimal strings and calculated with BigInt/unconstrained SQL NUMERIC. Prices never use floating-point arithmetic. Customer identity comes from the access token, and payment starts through an explicit checkout action.

## Important docs

| Document | What to read it for |
|---|---|
| [Assumptions](docs/ASSUMPTIONS.md) | The business rules we selected, including reservations, refunds, retries and capacity |
| [Decision history](docs/OPEN_QUESTIONS.md) | Options we considered and why we picked them |
| [System design](docs/SYSTEM_DESIGN.md) | Transactions, locking, states and the important SQL/pseudocode |
| [Service architecture](docs/SERVICE_ARCHITECTURE.md) | Ownership and communication boundaries |
| [Workflow diagrams](docs/WORKFLOW_DIAGRAMS.md) | Checkout, payment, fulfillment and refund sequences |
| [API reference](docs/API.md) / [HTTP requests](api/tops.http) | Routes, request examples, authentication and error handling |
| [Security](docs/SECURITY.md) | API permissions, identities and infrastructure controls |
| [Operations](docs/OPERATIONS.md) | Unknown payments, retries, quarantine, metrics and backup/restore |
| [Capacity and scaling](docs/CAPACITY_AND_SCALING.md) | Resource limits, admission control and the scale-up path |
| [Verification results](docs/SUBMISSION_VERIFICATION.md) | What was actually tested and what remains unproven |
| [Follow-up verification](docs/SUBMISSION_GAPS_VERIFICATION.md) | Forced worker crashes, filters, history and metrics |
| [Load results](docs/LOAD_RESULTS.md) | Workload, accepted/rejected requests, latency and resource samples |
| [Roadmap](docs/ROADMAP.md) | Implementation steps and their evidence |

## Checks

For the build, unit tests, schema validation and formatting:

```sh
docker compose --profile tools run --rm --build tools npm test
docker compose --profile tools run --rm tools npm run validate:schemas
docker compose --profile tools run --rm tools npm run format:check
```

The integration suites run against the live Compose stack:

```sh
docker compose --profile tools run --rm --build foundation-checks
docker compose --profile tools run --rm --build checkout-checks
docker compose --profile tools run --rm --build payment-checks
docker compose --profile tools run --rm --build fulfillment-checks
docker compose --profile tools run --rm --build recovery-checks
docker compose --profile tools run --rm --build ui-checks
```

These checks create identifiable fixture data and retain order/audit history. They are for a development environment. The PowerShell runners under `scripts/verification/` also test load, dependency outages, forced worker crashes and isolated backup/restore; some deliberately interrupt services. Read the [runbook](docs/OPERATIONS.md) before running them.

With Node 24.15 locally, you can also use `npm ci` and `npm test`.

## Current limits

The planned server budget is **8 GB RAM and four CPU cores**. The nine steady services have combined limits of 5,888 MiB and 3.35 CPUs. Build and test tools have separate budgets.

The measured load run sent 800 new requests through two Gateways. All 313 accepted orders completed once; the other 487 requests received 503 without acceptance. That run used capped containers on a larger shared host. It does not establish sustained capacity on a dedicated four-core machine.

This is a local simulator deployment. It does not include real payment/shipping providers, automatic failover, off-host backup storage or a production TLS setup. Operational metrics are available through protected endpoints; a metrics collector, dashboards and distributed tracing are not bundled.

Secrets, generated files, raw verification results and the original hiring brief stay local and are ignored by Git. The design and decisions needed to review the implementation are in `docs/`.

## Git workflow

Work starts on `feature/*` or `fix/*` branches and is integrated into `develop`. Releases go through `release/*` into `main`. See [Git workflow](docs/GIT_WORKFLOW.md). Publishing is a separate step.
