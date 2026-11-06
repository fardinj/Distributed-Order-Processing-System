# Verification plan

Status: scenarios below are the target verification plan, not blanket passing results. Executed step-1 evidence is in [SKELETON_VERIFICATION.md](SKELETON_VERIFICATION.md), and step-2 schema/auth/admin/concurrency evidence is in [FOUNDATIONS_VERIFICATION.md](FOUNDATIONS_VERIFICATION.md). Use real owner databases and RabbitMQ for transaction/crash/coordination tests; mocks alone cannot prove locks or acknowledgments.

## Core invariant scenarios

Step-3 executed admission, checkout, expiry and cross-owner preparation evidence is recorded in [CHECKOUT_VERIFICATION.md](CHECKOUT_VERIFICATION.md). The financial/fulfillment/cancellation cases below remain target scenarios until their milestones execute them.

| Scenario | Required evidence |
|---|---|
| Concurrent create replay | 50 same customer/key/payload requests yield one order/current status, one admission slot and one hold generation; no timer renewal |
| Payload conflict/scope | Changed payload conflicts; another authenticated customer may reuse key; caller cannot select another customer's identity |
| Replay after progress | Same ID/current Commerce status after payment/expiry/cancel; no reopening, new charge or duplicate effect |
| Server snapshots | Forged client price rejected/ignored; paid name/type/price/duration remain unchanged by admin edits |
| Quantity rules | Merge duplicate physical lines; reject duplicate nonphysical lines and quantity other than 1 for digital/subscription |
| Whole-rial large money | Values beyond 2^53 and 2^63 round-trip product/order/bank/refund/UI exactly as decimal strings, including large multiplication/sum |
| Money validation | Reject fractional/exponent/NaN/infinity/negative input; resource rejection is explicit, never float rounding/truncation or hidden business amount cap |
| Migration precision | Actual DB columns remain unconstrained NUMERIC with finite/integer checks after ORM generation/introspection; adapter arithmetic does not inherit decimal precision loss |
| Last units | Stock 5, 100 competing checkouts: at most five active unit allocations, no negatives or ordinary paid shortage |
| Atomic line reservation | Revised confirmed quantity 3 with stock 2 fails allocation atomically; basket revision may propose 2, never silently pay original 3 |
| Checkout timer/replay | ACTIVE expiry is database T+5m and replay cannot extend; duplicate expiry releases once |
| Expired stock available | Atomically settle/reacquire before gateway; old expiry cannot release newer generation |
| Basket changed | Quantity 3 becomes 1 or line removed at zero; new total/revision/reasons shown and confirmed before payment |
| Stale checkout/price | Previous revision cannot pay old amount after quantity/catalog change; original idempotency identity remains |
| Payment promotion | Enter at T+4:50, callback after T+6: old checkout expiry cannot release PAYMENT_PENDING |
| Payment outcome stock | Success -> ALLOCATED, no inventory increment; failed -> one valid release; unknown/unreachable -> hold retained |
| Delayed payment command | Promotion committed before Billing consumes; stock stays held and command remains recoverable |
| No-charge cancel tombstone | Cancel arrives before original/replayed payment request: Billing no-charge acknowledgment prevents later charge before Commerce release |
| Bank result timeout | Timeout after committed success reconciles original result once, never a second charge or failure at minute 15 |
| Bank deadline | First durable initiation fixes 15m; pending becomes definitive failed; success/deadline race gives one immutable outcome; restart cannot reset |
| Bank inaccessible at deadline | Local UNKNOWN/stock protection persists until authoritative lookup; no time-only guessed release |
| Out-of-order item command | No effect before applied authoritative payment success/current revision; deferred work remains recoverable |
| Duplicate item delivery | Concurrent workers apply one committed effect/attempt per actual execution, not per transport duplicate |
| Digital repeat order | One entitlement/customer/product with per-order-item grant evidence; duplicate message grants no extra effect |
| Subscription contention | Two paid orders extend twice from max(expiry, DB time), duplicate messages do not extend again |
| Physical consumption | ALLOCATED -> CONSUMED + one shipment; no second decrement; crash rolls effect/state together |
| Final-item race | Two last workers converge to COMPLETED once; no stuck aggregate |
| Admin discrepancy | Nonexistent held unit is corrected/quarantined; failed paid whole line enters refund resolution; refund does not relist phantom stock |
| Partial/full refund | 100 paid, failed 50 line: retain successes, confirm 50 once, summary PARTIALLY_REFUNDED; full confirmed 100 -> REFUNDED, not all-items COMPLETED |
| Refund pending/failure | Unknown/failed return is outstanding, not returned money; durable logs/review/reconciliation path |
| Refund budget races | Duplicate disposition/results and concurrent 50/30 returns cannot exceed captured/item budget or return twice |
| Refund/fulfillment race | Commerce item disposition prevents delivery plus refund for the same line |
| Paid cancellation | Before first start, duplicate calls accept one intent/refund and stop all item work |
| Cancellation/start cutoff | Same Commerce lock picks one winner; after first start reject order cancellation without revoking successes |
| Unknown-payment cancellation | Intent blocks dispatch; later success refunds, definite failure does not; stock release obeys known outcome/no-charge acknowledgment |
| Retry baseline | Initial + three exponential/jittered retries reaches a recoverability checkpoint; duplicates do not consume attempts |
| Adaptive continuation | Healthy/transient progress after checkpoint gets scheduled bounded recovery rather than automatic mandatory review |
| Outage/pressure deferral | Open circuit/longer due times preserve admitted work without hot loops or compulsory manual escalation |
| Manual-review eligibility | Human-required/permanently invalid or excessive-cost repeated failure opens durable case with reason; no guessed probability or automatic refund solely from review |
| Successful/manual retry | Succeeded/refund-resolving items never rerun; explicit new cycles audited/idempotent and old generations harmless |

## Crash and boundary injection

| Crash point | Required recovery |
|---|---|
| Before create/hold/admission commit | No partial order/key/slot/stock leak |
| After acceptance before response/publish | Replay discovers accepted order; outbox publishes later |
| After publisher claim/confirm before mark | Lease recovers; duplicate publication is harmless |
| After stock promotion before payment publication | PAYMENT_PENDING remains protected; original stable command resumes |
| After bank charge/refund commit before response/local record | Same operation lookup recovers original money movement |
| After Billing result commit while Commerce down | Financial outbox retains result; projection converges once on recovery |
| After item effect before Commerce commit | Effect/evidence/stock/state roll back together |
| After item/result commit before broker acknowledgment | Replay preserves counts and history transitions |
| During release/reacquisition/admin correction | State, quantity movement/history commit together or neither |
| During cancellation/refund disposition | Intent/dispatch guard/outbox atomic; no half-selected resolution |
| During retry/manual-cycle scheduling | Durable due work/history/generation agree; no accidental budget reset |
| Expired Redis overlap lock with paused owner | Overlapping schedulers safe in SQL; old token cannot release new lock |

Use deterministic test barriers/hooks rather than sleeps hoping a race occurs. Fault controls stay development/admin-fixture scoped, not publicly forgeable payment results.

## API/service security and UI

- Test cross-customer list/detail/cancel/retry/refund access, forged customer/role headers, expired/forged/wrong-audience tokens and admin escalation.
- Test internal-service/gateway bypass, scoped DB credentials, broker publisher/consumer permissions and forged financial result rejection.
- Test provider login/session/revocation/admin step-up behavior with Redis down; no auth bypass or trusted-user shortcut.
- Test audited/versioned/idempotent product deactivation and stock changes racing with reservations. Paid snapshots stay fixed; unpaid revisions reconfirm.
- Test DTO/body/quantity/page/query bounds, parameterized money/raw SQL adapters, secret/error/log redaction and normal session/CSRF integration where cookies are used.
- Walk Persian customer/admin flows on desktop/mobile: exact large IRR strings, RTL/LTR IDs, countdown-to-payment-pending change, basket confirmation, cancellation, partial refund, admin correction/review, loading/empty/unknown/overload states. UI controls do not replace direct API authorization tests.

## Outages, overload and durability

Run the stack inside its combined 8 GB/4-core budget; report actual usable memory, storage, versions and limits. Use an external load generator or count it in the same envelope. Ramp offered load past sustainability, then reduce it.

Required evidence: admitted and rejected rates are distinct; 429/503 happen before excess new acceptance; shared SQL admission cap holds across gateway replicas; replay consumes no extra slot; financial results/refunds/recovery keep progressing; memory/pools/buffers stay bounded; accepted backlog drains after pressure falls. Reconcile every accepted order/payment/refund/effect. No CPU-pressure/manual-review shortcut may discard admitted work.

- Redis unavailable: bypass cache/overlap lock, SQL safeguards intact, bounded weaker per-instance quotas visible, auth remains enforced.
- RabbitMQ full/down: publisher rejects/pauses safely, SQL outbox retained; no drop-head/TTL deletion of live work. DLQ/delivery-limit behavior preserves recoverability rather than becoming a silent final state.
- PostgreSQL unavailable: unsafe writes fail and consumers do not acknowledge uncommitted work; leases/continuations recover after restart.
- Low disk/backlog: new admission closes before reserve is exhausted; retained financial/completion work can drain. Document finite storage and actual restore assumptions.
- Delayed Billing/bank/Identity: bounded calls/pools/circuits prevent global starvation; unknown financial operations retain stock/result lookup. Identity errors never fabricate successful auth.

## Results to record

For each executed scenario: date, command/fixture, configuration, expected/actual outcome, pass/fail and limitation. Report host/component memory, CPU, offered/admitted/rejected throughput, request percentiles, fulfillment time, reconciliation lag, outbox/queue age, DB pool/lock waits and final invariant counts. Record secure auth/admin load and large-number cost separately. A finite run is evidence for that workload, not universal capacity or high availability.
