# Roadmap and implementation steps

Status: Q01-Q21 choices are selected. Steps 1-8 have implementations and selected execution evidence as of 2026-11-07; see [submission evidence and limitations](SUBMISSION_VERIFICATION.md), [UI evidence](UI_VERIFICATION.md) and earlier milestone reports. Dedicated-host sustained benchmarking and production deployment remain separate work. The expanded scope is not bound by the original 5-7-day estimate.

Read ASSUMPTIONS.md for decisions, SYSTEM_DESIGN.md for transactions, SERVICE_ARCHITECTURE.md for ownership, SECURITY.md for controls, CAPACITY_AND_SCALING.md for host/admission limits and UI_SCOPE.md for UI scope. Record engineering defaults and measurements rather than reopening settled business choices.

## 1. Repository, services and resource smoke test

Completed: Compose/private network, four NestJS apps + managed Identity, private DB runtime/migrator roles, scoped broker accounts, generated secrets, health/logging/shutdown plumbing and initial resource checks. Domain schemas and authenticated catalog/admin APIs are completed in step 2; UI and workflows remain later steps. Root README documents the structure and commands.

- Initialize compatible pinned Node/TypeScript/NestJS/Prisma versions in one repo with Gateway, Commerce, Billing and Bank entry points; add maintained OIDC provider (proposed Keycloak).
- Compose private network, one PostgreSQL instance/private service databases/roles, Redis and RabbitMQ. Expose only gateway/controlled Identity routes; loopback-bind development management endpoints.
- Assign combined memory/CPU/pools per CAPACITY_AND_SCALING.md. API and worker subprocesses share their owner's budget. Add health/readiness, correlation fields, graceful shutdown and environment examples without real secrets.
- Confirm startup/idle memory for every component within the total 8 GB/4-core envelope; adjust tunables transparently before load work. Specify actual disk/durability/backup assumptions.

Exit: clean checkout can run all services; isolated runtime roles cannot write another owner's database. Resource budgets are observed, not just listed.

## 2. Schema, exact IRR and identity/admin foundations

Completed: four forward migrations per owner, exact money guards, real OIDC customer/admin/service identity, protected reads, versioned/idempotent catalog and inventory APIs, fixtures and concurrency checks. Browser callback/UI remains step 7; business outbox publication begins in step 3.

- Implement owner-local migrations, constraints, indexes, receipts/outbox and state versions. Use explicit NUMERIC financial migrations and exact string/BigInt adapters; verify no ORM default precision ceiling.
- Add deterministic fixtures for products/types, stock, users/roles and simulator outcomes. Test seeds do not replace auth/admin APIs.
- Integrate maintained OIDC login/session and customer/admin/service identity. Enforce ownership in domain APIs, permissions in admin APIs and controlled admin provisioning.
- Implement product create/edit/deactivate plus audited/versioned/idempotent inventory adjustments, discrepancies/quarantine and immutable paid snapshots.

Exit: very large whole-rial values round-trip without loss; customers cannot impersonate one another or invoke admin writes; admin corrections preserve holds/accounting evidence.

## 3. Admission, checkout, idempotency and outbox

Completed: SQL capacity/slots, atomic canonical create/replay, five-minute holds and bounded expiry, versioned basket reacquisition/confirmation, protected coherent reads, source-version preparation/financial projection fields, and bounded per-owner outbox/inbox delivery. Financial result handlers arrive with their owning workflows; checkout preparation never charges. See CHECKOUT_VERIFICATION.md.

- Implement canonical quantities/customer-scoped create identity with current-status replay. Replays do not reacquire stock or consume another admission slot.
- Implement SQL-backed admission budget and atomic create/slot/order/items/revision/hold/history/preparation-outbox. Reject new overload explicitly before acceptance.
- Add five-minute checkout holds, safe expiry, atomic reacquisition and versioned BASKET_CHANGED quantity reduction/removal with customer reconfirmation.
- Build bounded per-owner outbox publishers/consumers with confirms, routing failure handling, leases, receipts, state guards and recovery. Do not rely on broker order.
- Add protected order detail/list and source-version/pending financial projections.

Exit: parallel replay creates one order; last-unit contention is resolved before payment; rejected requests produce no leaked holds/charges; broker outage retains committed work in SQL.

## 4. Payment-owned stock and bank recovery

Completed: atomic entry/reacquisition/promotion, stable financial identities, Billing recovery leases/attempts/status outbox, authenticated Bank execution and durable 900-second deadline, versioned stock/result application, durable fulfillment jobs and internal no-charge cancellation fences. Jobs execute in step 5; public cancellation eligibility/actions arrive in step 6. See PAYMENT_VERIFICATION.md.

- Gateway entry atomically promotes current stock to PAYMENT_PENDING and enqueues a stable payment command. Old checkout expiry cannot release it.
- Billing deduplicates commands and invokes Bank outside SQL transactions. Bank operation initialization fixes the 15-minute pending deadline; immutable final outcomes and idempotent charge keys prevent duplicates.
- Reconcile UNKNOWN with increasing capped lookup and deadline lookup. Local unreachability never fabricates failure. Persist financial result/history/outbox together and apply Commerce projection once.
- Success converts stock to ALLOCATED and dispatches items; failure releases once. Cancellation/no-charge tombstones must fence delayed payment commands before release.

Exit: stock remains protected throughout pending/unknown payment; timeout-after-charge recovers success once; pending bank operations fail at their deadline; stale expiry/result messages do not corrupt inventory.

## 5. Typed fulfillment, aggregate and refund workflows

Completed: distinct typed effects with transactional evidence/retries, immutable first-start cutoff, serialized aggregate completion/settlement, audited admin shortage disposition, captured-line/budget guards and idempotent Bank returns/log projections. COMPLETED requires all payable items succeeded; failed-line settlement is RESOLVED with a separate financial summary. Public recovery controls and adaptive cost/circuit policy remain step 6. See FULFILLMENT_VERIFICATION.md.

- Implement separate local digital, subscription and physical modules in Commerce; lock parent order first, keep SQL transactions short, unique per-item evidence.
- Extend fixed-day subscriptions once per item; consume paid physical allocation without another stock decrement; record unique shipment and admin shortage disposition.
- Atomically update item/aggregate/history/outbox. Parent locks serialize final-item and cancellation races.
- For confirmed permanent whole-line failure, commit unique refund disposition + command and stop fulfillment. Billing guards refundable budgets and calls bank with stable refund key.
- Reconcile unknown returns, append refund logs and expose pending/confirmed amounts plus partial/full financial summary. Never relist admin-miscounted nonexistent stock.

Exit: duplicate delivery cannot duplicate access/extension/shipment/charge/refund; order COMPLETED requires all items fulfilled; 100 paid with failed 50 line returns exactly 50 while retaining successes.

## 6. Cancellation, adaptive retries/review and Redis

Implemented contracts/defaults: [CANCELLATION_RECOVERY_AND_REDIS.md](CANCELLATION_RECOVERY_AND_REDIS.md). Public guarded actions, SQL-safe Redis degradation, financial scheduling preference and storage admission monitoring are available. Load capacity remains unmeasured until step 8.

- Paid cancellation wins only before first item starts, using Commerce parent lock. UNKNOWN-payment intent blocks dispatch and refunds later success; definite failure needs none. Report cancellation separately from confirmed returned money.
- Normal work cycle is initial + three retries, 10s base/factor 2/positive jitter; after cycle assess recoverability, health and cost. Continue/defer with bounded due work where plausible, review when human action/low recovery likelihood/excessive repeated cost warrants it.
- Add durable review list/inspect/guarded manual-cycle actions and attempt history. Success/refund-resolving work never reruns. Outages/pressure defer rather than auto-discarding admitted work.
- Implement all Redis features and selected outage behavior: cache/overlap-lock bypass with SQL guards, weaker bounded local quotas, API auth intact.
- Implement priority lanes, backpressure, broker no-eviction policies and low-disk admission stop. Financial outcomes/recovery take priority over new arrivals.

Exit: cancellation/fulfillment has one winner; more than three lookups can reconcile payment; healthy recoverable work is not forced into review solely by count; overload preserves admitted workflows and rejects new work transparently.

## 7. Small Persian UI

Implemented: [usage guide](UI_GUIDE.md), [browser/API evidence](UI_VERIFICATION.md), root PRODUCT.md and DESIGN.md. Static assets live in the gateway; no new steady service was added. Real customer OIDC and guarded admin fixture flows were exercised, with desktop/mobile review.

- Serve static RTL customer/admin client through gateway; integrate OIDC without client/admin secrets.
- Customer: catalog, quantity selection, revised checkout/timer, simulated payment, item/order/refund progress, eligible cancel/retry.
- Admin: products, inventory reasoned adjustments, discrepancies, history/refund logs and manual review.
- Exact rial-string display, visible pending/unknown/review states, bounded polling/backoff, basic responsive/keyboard behavior. API remains the security boundary; keep UI implementation simple.

Exit: reviewer can demonstrate core flows in Persian on desktop/mobile; direct unauthorized API calls still fail; very large monetary strings remain exact/readable.

## 8. Failure, load and submission evidence

The 2026-11-08 [follow-up](SUBMISSION_GAPS_VERIFICATION.md) addresses the requirement review: deterministic before/after-commit worker kills, order filters, complete event history and owner-local metrics. Production deployment and dedicated-host sustained capacity remain outside the executed evidence.

Implemented and executed: [submission matrix](SUBMISSION_VERIFICATION.md), [load results](LOAD_RESULTS.md), [API/reference collection](API.md), [workflow diagrams](WORKFLOW_DIAGRAMS.md) and [operations/backup runbooks](OPERATIONS.md). An 800-arrival/two-Gateway run completed all 313 SQL-accepted orders; all tested dependencies recovered; fresh-install and four-owner snapshot restore passed. Container hard caps fit the selected budget on a larger shared host. The matrix explicitly lists unexecuted scenarios and production limitations; the plan below is not a blanket pass claim.

- Execute VERIFICATION.md with real PostgreSQL/RabbitMQ and deterministic boundary hooks; record commands, actual results and unresolved limitations.
- Ramp offered load on constrained hardware. Report admitted/rejected throughput separately and prove admitted work progresses/drains without runaway memory/backlog. Include Redis/broker/database outages and cross-owner result delay.
- Complete API docs/collection, README/local setup, migrations/seeds, state/sequence diagrams, resource config, retry/DLQ/unknown-payment/refund runbooks and backup/restore evidence.
- Review security controls with auth on; inspect Persian flows/screens once on desktop/mobile, batch corrections and confirm. A diagram/checklist does not replace execution evidence.

Exit: clean setup and selected failure demos are reproducible; measured capacity/configuration and a brief scale-up path are documented honestly. No unexecuted check is marked passing.

## Scope and delivery discipline

Required: selected stack, coarse services/private ownership/API gateway, outbox/inbox, exact IRR, reservations/payment/refunds, concurrency/recovery, admin APIs/auth and simple Persian UI. Retain accepted work under pressure. No UI polish project, real providers, generic saga framework, Kubernetes, service mesh or multi-region deployment is needed.

If time is tight, simplify presentation/tooling and keep the selected flows. Any removal of a selected business/security/correctness feature is a changed decision, not an unnoticed shortcut. Provider/version, resource-watermark and package choices are ordinary implementation decisions constrained by the documented policies.
