# Capacity, overload protection and scale-up

Status: D22 plans an 8-GB/4-core deployment. Initial service caps and startup/post-smoke memory were verified on 2026-11-06 in [SKELETON_VERIFICATION.md](SKELETON_VERIFICATION.md). Values below are tunable defaults, not measured workload capacity or an RPS promise. Disk/backups have developer-host assumptions; storage quotas and restore evidence remain pending.

## Resource envelope

Budget against 8 GiB (8192 MiB) initially; if the actual host provides 8 decimal GB, reduce allocations to its measured usable memory before deployment. The envelope includes Identity, databases, broker, UI serving and operating-system headroom. Build tooling/load generators should run outside this envelope; if colocated, reduce workload accordingly.

| Component | Initial memory budget MiB | CPU planning share, cores |
|---|---:|---:|
| API gateway + static Persian UI | 192 | 0.20 |
| OIDC provider (proposed Keycloak) | 2048 | 0.60 |
| Commerce API + all processor/scheduler roles combined | 640 | 0.60 |
| Billing API + financial workers combined | 384 | 0.30 |
| Bank simulator | 192 | 0.10 |
| PostgreSQL, including all service databases | 1536 | 1.00 |
| RabbitMQ, single local node | 640 | 0.40 |
| Redis | 192 | 0.10 |
| Lightweight metrics/log shipping | 128 | 0.05 |
| OS, filesystem cache, runtime overhead and spare capacity | 2240 | 0.65 |
| Total | 8192 | 4.00 |

These are budgets to validate, not proof that each runtime starts/fits. Limit Node heaps below their total role budget and account for native buffers. If API/workers run as separate processes, they split the listed service total rather than each receiving it. Avoid a large local observability stack. Keycloak recommends a 2 GB limit for smaller production-ready container deployments; provider memory is deliberately included ([container guidance](https://www.keycloak.org/server/containers)).

Use CPU weights and bounded concurrency rather than forcing every process to run continuously at its planning share. Set actual memory limits/tuning after startup/load measurements. One host/broker/database is not high availability; storage failure remains outside a promise of zero loss. Backups and restore validation are required operational evidence.

## Initial bounded settings

| Area | Starting configuration to validate |
|---|---|
| Commerce executions | 4 active item tasks total, not 4 per processor; rotate fairly across types/orders |
| Billing work | 2 active provider calls plus 2 small reconciliation/result slots; avoid starvation by charge work |
| Bank simulator | 4 active requests; delays represented by durable due times, not sleeping open SQL transactions |
| Gateway | 32 active domain requests; separate small reserved lane for existing-work controls/result ingestion |
| DB pools | Commerce 8, Billing 4, Bank 2, Identity initially 5; total includes all replicas/processes, then tune provider needs |
| PostgreSQL connections | Initial ceiling 50, leaving room for migrations/operations; cap query/work memory per connection |
| Broker consumers | Prefetch near actual execution slots; no unbounded in-process buffering |
| Publisher/scheduler | Batches of at most 50 initially, leased/claimed in SQL, yield between batches |
| API inputs | Initial 50 lines/order, physical quantity 100/line, 100 records/page, 64 KiB order body |
| Rate limits | Start ordinary authenticated API at 60/minute/principal with a bounded burst; login 5/minute/source and admin mutations 30/minute/principal, then tune with abuse/load evidence |
| Redis quota fallback | Same local policy per gateway instance, at most 10,000 cached limiter keys with expiry/LRU; document weaker combined quota and reset behavior |
| UI polling | One poll per visible order every 5–10s; pause hidden tabs, back off on overload; no per-row polling |

Limits concern work size, not a maximum money value. An oversized HTTP payload can still receive 413 before admission, even when its content is a valid large integer. Values are transparent implementation defaults, not user-selected business caps. Revisit if a valid demonstration flow needs more.

## Admission is separate from acceptance

1. Authenticate and identify replay/existing-work requests cheaply. Request shape/body/concurrency bounds apply before expensive processing.
2. Check local pressure and a shared Commerce SQL admission budget for new orders. A singleton capacity row plus guarded counters can atomically cap admitted unfinished orders. Increment with order creation; decrement once only when order resources/financial work have settled or a measured review-handoff budget takes ownership. Unresolved payments/refunds do not disappear from capacity accounting merely because an operator was alerted. Reconcile counters from owner state. Redis is not the authority.
3. New-order admission commits its idempotency record, order, inventory work and outbox atomically. A committed order is accepted even if its HTTP response is lost; replay the original key to discover it. Never tell a client a committed request was discarded.
4. Reject excess *unaccepted* work explicitly: 429 for caller quota, 503 for aggregate capacity/dependency pressure, with Retry-After. Do not open a bank operation or reserve stock for rejected work.
5. Keep rejected requests out of business queues. Client retry uses the same idempotency key; existing replay must not consume another admission slot. Under extreme pressure even a read may return a retryable error; no admitted order disappears.

Proposed initial pending-order budget: 200 non-settled admitted orders, then adjust using measured size, queue age and drain rate. Shared counters protect concurrent admission; local CPU/lag/RSS readings supplement them. Never claim a Redis-independent global admission cap based only on each gateway's memory.

Step 3 implements this SQL budget and slot ledger. Expired unpaid checkout releases its settled slot; explicit refresh requires capacity again. New admission also checks a 10,000-row pending outbox/inbox threshold; each owner bounds pending inbox staging at 10,000, and broker queues reject publication at 1,000 messages/16 MiB. Local create concurrency/RSS/lag safeguards and reconciliation commands are documented in [CHECKOUT_AND_OUTBOX.md](CHECKOUT_AND_OUTBOX.md). Host CPU/disk watermarks and financial priority lanes remain later work; current limits are not measured RPS.

## Priority and backpressure

Give processing capacity first to authoritative payment results, reconciliation, refunds, cancellation, stock-state transitions and recovery of accepted workflows. Fairly share remaining execution slots among accepted fulfillment work. Restrict new orders, broad list queries and expensive administrative scans first. Use separate command classes/queues and reserved execution slots rather than relying on arrival order in one long queue.

Initial pressure signals: sustained host CPU above 80%, RSS approaching 75–80% of usable RAM, event-loop lag, DB pool wait/lock time, broker alarms, oldest outbox/work age and low disk reserve. Use hysteresis and multiple samples before reopening admission. A healthy component can continue accepted work while another circuit is open; do not block every consumer globally.

Retry timers remain in SQL. Pause/defer unhealthy work with longer due times and circuit-breaker probes; avoid many worker sleeps or immediate nack/requeue loops. Three retries are a recoverability checkpoint, not an automatic discard or human escalation on CPU pressure. Manual review cases remain durable and visible.

## Never shed already accepted business work

- Persistent outbox/owner state remains recoverable while RabbitMQ is full/down. Publisher failure leaves the outbox unpublished; retry later.
- Configure bounded broker queues to reject new publication rather than evict old accepted commands. No TTL or drop-head policy may silently delete live financial/fulfillment work. RabbitMQ's documented overflow and delivery-limit behaviors must be configured deliberately ([quorum queues](https://www.rabbitmq.com/docs/quorum-queues)).
- Business retries get explicit durable generations. Broker redelivery limits/dead lettering cannot be treated as final business completion; retain recoverable state, inspect DLQ and repair stranded work.
- Keep money, effect uniqueness and recovery source in PostgreSQL. Redis key eviction may degrade speed/quotas, not lose an order.
- Stop admitting new work before disk reserve is exhausted. Track DB/WAL/outbox/broker/log growth and retain space for completion, refund, checkpoints and recovery. A finite disk cannot accept an infinite outage backlog.
- Drain on shutdown, acknowledge only after local commit/durable handoff, and recover leases on restart. Do not kill an admitted workflow to free a slot; end or review it through its recorded state machine.

## Measurement and acceptance

Warm up all services and record actual memory/CPU first. Ramp offered new orders gradually while keeping catalog mix/order size explicit; run a separate hot-product contention test. Report offered, admitted and rejected rates separately, request latency, fulfillment time, payment/refund lookup lag, memory, CPU, queues/outbox ages, DB waits and final invariant counts.

Acceptance target: beyond sustainable capacity, rejections rise while memory/backlog remain controlled; accepted work keeps progressing and drains after load falls. Inject dependency outages and Redis failure. Reconcile every accepted order/charge/refund/effect after recovery. No specific sustainable RPS is claimed before measurement. The 15-minute bank timeout is simulated behavior, not an allowed request latency.

## Brief scale-up path

1. Measure first: improve indexes/queries, keep transactions short, reduce polling and tune pools/concurrency. More workers can worsen hot-inventory contention.
2. Add RAM/CPU to the host, then remeasure; the architecture stays unchanged. Move Identity/observability off the order host if they dominate the envelope.
3. Move PostgreSQL and RabbitMQ to dedicated durable hosts/services; tune storage and use backup/restore plus required replication. A broker cluster on one host does not protect host failure.
4. Add gateway and Commerce/Billing replicas. Redis restores shared rate limits; SQL admission/uniqueness and outbox/inbox keep correctness. Rebudget total DB connections and use a pooler if necessary.
5. Scale processors by measured queue pressure while keeping Commerce's shared ownership and order/subscription/inventory locks. Only split a domain into a new owning service when the added result/cancellation protocols are justified.
6. Partition/retain completed history/outbox data and use read projections for heavy reporting. Never archive unresolved financial operations or live work out of their recovery path.

Step 5 additionally rejects a computed checkout work snapshot over 250,000 UTF-8 bytes before acceptance, leaving envelope headroom for server-derived prices. This is a work/payload bound, not a monetary ceiling; see FULFILLMENT_AND_REFUNDS.md. Typed workers/refund schedulers share existing owner pools and runtime caps. Unsettled review money retains its admission slot.
