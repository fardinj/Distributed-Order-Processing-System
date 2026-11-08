# Open questions, rabbit holes, and proposed choices

Status: Q01-Q21 selected. Q11-Q21 resolved on 2026-11-05 supersede earlier conflicting suggestions. ASSUMPTIONS.md is the current canonical register; historical options below preserve rationale.

The original hiring brief is kept locally and excluded from Git. The implementation decisions and their rationale are recorded here and in ASSUMPTIONS.md, so this document does not depend on a private source file.

Read this file first, then [assumptions](ASSUMPTIONS.md), [system design](SYSTEM_DESIGN.md), [roadmap](ROADMAP.md), and [verification](VERIFICATION.md).

## How we decide

For each question, choose an option or write an alternative. Record the answer and rationale here, add it to the accepted decisions in ASSUMPTIONS.md, and update the affected design and tests. Until then, recommendations are discussion material only.

Priority P0 means resolve before implementing the affected workflow. P1 means resolve before its implementation step. P2 means document a limit before submission.

## Q01 — What happens when only part of a paid order succeeds? [P0]

Example: an order costs 100 units: digital access costs 20, a subscription costs 30, and a physical item costs 50. Physical stock was reserved before payment. Payment succeeds and the nonphysical items complete, but an administrator's stock-count/data mistake means the physical unit does not actually exist.

| Option | Result in this example | Cost or risk |
|---|---|---|
| A. Keep successes and retry eligible failures | Access and subscription stay active; physical item remains failed until an eligible retry succeeds | Customer has paid for an unfulfilled item; needs a visible unresolved state and documented operational handling |
| B. Compensate the whole order | Revoke access, reverse the extension, release any stock, and simulate a refund | Every compensation can fail; reversing an already-used entitlement may be impossible |
| C. Keep successes and refund failed items | Keep access and subscription; refund 50 | Requires item-level refund amounts, idempotency, reconciliation, and refund states |

Selected: C. Keep completed items and refund the failed items. In the example, keep access and subscription and refund 50; the order's financial summary becomes PARTIALLY_REFUNDED after the refund succeeds. If every item is unfulfillable and the whole captured amount is returned, it becomes REFUNDED. Pending or failed refunds are not successful refunds. Store a list of refund records and append-only refund logs.

Policy provenance: the user chose this from Digikala policy. This records the user's stated inspiration; it is not an independently verified description of Digikala's current policy.

Accepted business assumption: this paid physical-stock mismatch occurs only because administrators made a mistake in stock counts/data. Normal customer concurrency must be handled by Q02 and must not produce this scenario. Infrastructure failures still need recovery; they do not automatically imply an item needs a refund.

Decision: accepted as D01/D03; Q12 now selects prompt whole-line refund execution and recovery-aware retries.

## Q02 — When is inventory reserved? [P0]

Example: stock is 1. Two customers order that product. Both payments succeed before either physical worker runs.

| Option | Behavior | Trade-off |
|---|---|---|
| A. Reserve after payment | Only one physical worker succeeds | Fits the stated fulfillment sequence; the other customer can be charged without fulfillment |
| B. Reserve before payment | Only the reservation holder proceeds to payment | Requires expiration, release on failed payment, and handling payment success after expiration |
| C. Authorize payment, reserve, then capture | Avoid capture if stock is unavailable | Adds authorization/capture semantics beyond the requested payment simulation |

Selected: B. Reserve physical stock at final checkout for five minutes and return server expiry. Q11 now promotes the reservation during payment; Q18 adds a simple Persian UI for the countdown/flows.

At the gateway-entry request, check the reservation using database time. An unexpired hold protects its stock. If it has expired, atomically recheck/reacquire stock before proceeding: if available, continue to the gateway; otherwise return "basket changed" and update the basket. Never redirect/charge based only on the client timer or a nonlocking stock read.

Examples:

- 12:00: reserve the last unit; expires at 12:05. At 12:04, gateway entry can use the active hold.
- At 12:06, the hold has expired but stock remains available: revalidate and reserve before gateway entry.
- At 12:06, another customer has reserved the released unit: do not enter the gateway; return the changed basket and updated totals.

Decision: D02 refined by selected Q11/Q13. Checkout holds last five minutes; payment entry explicitly promotes/renews them until bank outcome. Revised confirmed quantities reserve atomically; quantity reduction happens in a new basket revision with confirmation.

## Q03 — What does payment timeout mean? [P0]

Example: the simulator records a successful charge, then the response is lost. The worker sees a timeout and RabbitMQ redelivers the message.

- A. Timeout means unknown outcome. Look up the original payment operation and retry using the same stable operation key. No second logical charge.
- B. Timeout is a deterministic pre-charge failure. Safe only if the simulator explicitly guarantees no charge occurred; it does not demonstrate ambiguous-outcome recovery.

Selected: A. A timeout leaves an unknown outcome. Schedule reconciliation with increasing delays until an authoritative bank result is obtained. Always use the original stable operation key; a lookup or repeated idempotent call is not a new charge. Include timeout-before-charge and timeout-after-charge fixtures.

The bank simulator must resolve still-pending operations to FAILED after 15 minutes. This must be a bank-side durable final result, not an application guess based on elapsed time. An already successful operation stays successful: a lost success response must reconcile to the original success, not become a failure at minute 15. Once the simulator finalizes failure it must not later charge that operation.

Example: first durable bank initiation at 12:00 fixes deadline 12:15 under selected Q14. A pending operation fails at that deadline; local unreachability still means UNKNOWN until lookup. Stock remains payment-held under selected Q11, independently of the expired checkout timer.

Decision: D04 with Q14/Q12 clocks and recovery policy selected. Financial reconciliation is separate from normal fulfillment work cycles.

## Q04 — Which retries are allowed? [P0]

Example: a digital worker encounters a temporary database error; a physical worker has insufficient stock; a payment receives a definitive decline.

- A. Automatically retry transient errors; stop permanent errors; permit explicit retry of selected business failures after conditions change.
- B. Automatically retry every failure until a limit. Simpler classification, but wastes work on invalid input and can hide business failures.
- C. Require manual retry for all failures. Easier scheduling, weaker unattended recovery.

Selected: A. Retry transient errors automatically; stop permanent errors; allow eligible manual recovery. Stock unavailable before payment follows Q02/Q13. Confirmed post-payment admin stock discrepancy follows Q01/Q12 prompt refund. A definitive payment decline is final for that operation and must not trigger another charge.

Budget refined by Q14 on 2026-11-05: one initial attempt plus three exponential/jittered retries is a normal cycle. Then assess recoverability/cost: continue/defer if plausible and affordable, manual review when unlikely/human-required or repeated work too costly. Succeeded items never run again. Permanent errors follow their business resolution without pointless retries.

Example: digital execution and three retries fail while a dependency is unavailable. Defer behind a health circuit and resume on recovery; do not require manual review merely because of count. Duplicate deliveries do not spend attempts. Human-required failures open review with reason; review alone does not trigger refund. Bank-result lookup continues independently.

Decision: D05 refined by selected D16/Q14; base 10s, factor 2, bounded positive jitter and explicit audited manual cycles. Refunds use the same recovery-aware classification with independent unknown-outcome lookup.

## Q05 — Is cancellation an API feature, and when is it legal? [P0]

Example: cancellation races with the payment worker; another cancellation arrives after stock was reserved and a shipment created.

- A. Support cancellation only before payment begins. Serialize cancellation and payment start through the same order lock; whichever commits first determines eligibility. Return a conflict after payment begins.
- B. Support cancellation after payment but before fulfillment. Requires refunds and a rule for workers already running.
- C. Support partial cancellation during fulfillment. Requires item-level cancellation, compensation, and irreversible-action rules.

Selected: B. Accept cancellation after payment succeeds and before fulfillment. Stop pending fulfillment safely, refund the captured payment, and release eligible stock allocation exactly once. This explicitly adds customer-requested refunds independently of Q01's admin-discrepancy scenario. Partial cancellation after fulfillment has begun is not selected.

Example: payment 100 succeeds, but no item has started. Cancellation wins the shared order lock before an item worker, records cancellation intent, prevents any item from beginning, and schedules a full refund. Pending/unknown refunds remain visible; do not report REFUNDED until confirmed. A cancellation request racing with fulfillment requires the precise cutoff in Q15.

Decision: D06 with selected Q15 first-start cutoff and UNKNOWN-payment intent, plus Q12 refunds. Accepted cancellation blocks guarded item starts and does not merely relabel uncontrolled work.

## Q06 — What identifies an idempotent create-order request? [P0]

Example: customer C sends key K twice with the same items. Later C reuses K with a different quantity. Another customer also sends K.

- A. Scope K by customer and operation; replay the same logical request, reject changed payloads, allow another customer to use K.
- B. Scope K globally. Easier uniqueness rule, but unrelated customers can collide.

Selected: A. Scope by customer and create-order operation. Replay of the same logical payload returns the existing order ID and its current status. Reuse with a different payload is a conflict; another customer may use the same key independently.

Example: original response is order O / CHECKOUT_RESERVED. Replaying after payment returns O / PROCESSING (or its actual current status), not a frozen checkout response. Replaying after expiration does not renew the hold; replaying after cancellation does not reopen the order.

Implementation suggestions still to refine: required Idempotency-Key header; canonical hash excluding current catalog prices; immutable original pricing snapshots; lifetime key retention; invalid requests need not reserve keys. Canonical quantity normalization depends on Q07/Q13. Authentication is Q10; caller-supplied customer ID alone is not proof of identity.

Decision: accepted as D07 for scope, conflict behavior, and current-status replay.

## Q07 — What do quantity, money, and subscription extension mean? [P1]

Examples: two identical digital items; three monthly subscriptions on one order; two concurrent orders extending the same customer's subscription.

- Quantity: allow positive integer quantities for every type, or restrict digital/subscription lines to quantity 1?
- Money: integer minor units in one seeded currency, or multiple currencies and decimal scales?
- Subscription: add duration from max(current expiry, current time), or reject overlapping subscriptions? Does a month mean a calendar month or a fixed number of days?
- Digital access: one entitlement per customer/product with fulfillment evidence per item, or one access unit per quantity?

Selected: integer minor units in one declared currency; positive physical quantities; digital and subscription quantity 1; merge duplicate physical product lines and reject duplicate nonphysical lines. Use fixed duration days and extend from max(expiry, database time). Record a unique extension per order item so retries do not extend twice. Multiple separate subscription orders each legitimately extend once.

Example: physical quantities 1 and 2 of the same product normalize to 3. Two separate paid subscription orders each add their duration once; duplicated delivery does not add another extension. If subscription expiry is in the past, extend from database time.

Decision: D08 with Q19 now selecting whole IRR decimal strings/no business amount ceiling and Q20 selecting host/resource safeguards. No mixed currencies or calendar-month arithmetic.

## Q08 — Where do the simulated service boundaries live? [P0]

Example: a shipment is recorded, then the worker crashes before acknowledging its message.

- A. Fulfillment simulations write local records in the same PostgreSQL transaction as item completion. A crash commits everything or rolls everything back.
- B. Each simulator commits independently, like an external service. The worker must reconcile completed effects using stable operation keys after a crash.

Selected: A for digital, subscription, and shipping, with separate module interfaces; B for the payment simulator to demonstrate timeout ambiguity explicitly. Each local simulated effect and its local completion evidence share a transaction. The requested service-separated deployment does not make SQL transactions span databases: canonical order state may need a later idempotent result update from the effect owner.

If choosing B for fulfillment, add durable operation IDs, claim leases, fencing against stale workers, and lookup/reconciliation to the design. A unique local fulfillment row alone cannot prevent duplicate external shipments.

Outbox: selected for durable SQL-to-RabbitMQ handoffs. Example: fulfillment commits access and completion evidence, then its process crashes before publishing ItemFulfilled. A local outbox row committed with the effect lets a publisher emit the result later. Order creation, payment/refund results, reservations and fulfillment results need this pattern wherever committed state requires a message. Consumers still need transactional receipts/domain idempotency; outbox may publish duplicates.

Decision: D09; selected Q16 keeps order/items/fulfillment together in Commerce, Billing separate. Q17 selects Commerce coordination through durable commands/results.

## Q09 — What does the Redis requirement actually require? [P1]

The task says: "Short-lived distributed lock, caching, rate limiting" without explaining whether all three are mandatory or which workflows should use them.

Example: a Redis lock expires while its worker pauses; another worker acquires the same lock. Separately, Redis becomes unavailable while PostgreSQL is healthy.

- A. Demonstrate all three: a best-effort scheduler lock, product-read cache, and API rate limiter. Preserve every correctness rule in PostgreSQL.
- B. Implement only the Redis uses the evaluator confirms are required.

Selected: implement all three. Scheduler overlap stays safe without its Redis lock. Use expiry and a unique ownership token with conditional release. Validate order prices against PostgreSQL, not cache.

Selected outage behavior: bypass cache and scheduler lock while retaining SQL safeguards; keep API available with explicitly weaker rate limiting. Suggested implementation: bounded in-memory per-instance limiting, with limited key memory and expiry. Multiple instances no longer share a strict quota, counters can reset on restart, and traffic distribution changes effective limits. Authentication, authorization, validation and SQL guards remain enforced. Login/admin endpoints need particular abuse protection under Q18/Q20; Redis loss does not make them anonymous.

Decision: D10 plus selected Q20 host/admission policy; initial normal/fallback numerical limits and memory bounds are in CAPACITY_AND_SCALING.md for measurement.

## Q10 — What are the operational and security limits? [P1/P2]

Example: a client asks for another customer's order, or submits 100,000 lines; a load test reaches a database connection limit before worker CPU is busy.

Originally open: access, resource limits, concurrency, throughput, retention, stock management and product mutation. Selected Q18–Q21 now define identity, IRR money, constrained-host/admission and admin adjustment policies; numerical implementation defaults remain measurable/tunable.

Selected direction: no trusted-customer bypass. Authenticate callers, enforce customer ownership and admin permissions, and provide admin management for catalog/inventory data. Include appropriate security controls and verify that performance remains reasonable. Test seeds may initialize fixtures but cannot replace authorization or required admin APIs.

Example: customer A cannot read/cancel/retry B's order or submit B's identity to acquire B-scoped idempotency. Customers cannot set product price, stock, subscription duration, or grant themselves admin rights. An admin stock correction is audited and coordinated with active reservations; it cannot be a blind counter edit.

Decision: accepted as D11 for access/admin/security direction. Exact identity model and permission lifecycle are Q18; currency Q19; workload/input limits Q20; admin mutation scope Q21. "All security options" is a requirement to cover the relevant attack surface, not a finite selectable feature list or security certification. Proposed controls are in [SECURITY.md](SECURITY.md).

## Rabbit holes to time-box

| Rabbit hole | Why it attracts work | Boundary to propose |
|---|---|---|
| Full saga engine and reversal of successful items | Partial failure sounds like it requires one | Q01 selects item refunds; retain successes and implement durable refund recovery |
| Unbounded infrastructure expansion | Services now require isolation | Separate services/private network/API gateway are selected; Kubernetes, service mesh and multi-region remain optional |
| End-to-end exactly-once messaging | Payment says exactly once | At-least-once delivery plus idempotent durable effects |
| Redis as inventory or payment authority | Fast counters and locks look sufficient | SQL constraints and transactions own correctness |
| Generic workflow framework | Three item types suggest abstraction | Three explicit processors behind a small interface |
| Real payment/shipping providers | More realistic failures | Deterministic simulators with documented contracts |
| Complete commerce platform | Taxes, discounts, returns, carts, addresses | Include only fields required to demonstrate the task |
| Event sourcing or CQRS infrastructure | Event history is required | Transactional audit events plus ordinary relational state |
| Unlimited retries and blind DLQ replay | Appears to improve reliability | Bounded retries, visible failures, eligibility checks |
| Broad performance tuning | "Heavy load" has no number | Prove stock safety and report measured bottlenecks first |

## Current decision status

All numbered business questions have a selected answer. Q01–Q10 above preserve earlier discussion; use the decisions below and ASSUMPTIONS.md where later refinements conflict. No old “unresolved” note should block a choice resolved here. Engineering defaults still need implementation and measurement, not another business questionnaire.

## Q11 — Reservation while payment is in progress [selected 2026-11-05]

Selected: at gateway entry renew/reapply the hold and promote it to PAYMENT_PENDING. Checkout's five-minute expiry no longer releases it. Keep it until payment's authoritative terminal result: FAILED releases once; SUCCEEDED converts to ALLOCATED paid stock for fulfillment. UNKNOWN continues to hold inventory.

Example: checkout at 12:00 expires at 12:05. Gateway entry at 12:04:50 promotes the hold; payment success at 12:06 retains its units for shipment. An old 12:05 expiry message cannot release them. If bank failure is later known, release once. If Billing cannot be reached, do not infer failure from the clock.

If entry is after checkout expiry, atomically reacquire first or return the Q13 changed basket. Duplicate gateway entry does not create another bank operation or timer. Stock promotion and the payment-command outbox row commit together. D13 replaces strict five-minute release during payment and preserves D03's admin-only paid-stock discrepancy assumption.

## Q12 — Refund execution [selected]

Accept the prior suggestion: promptly refund each confirmed permanently unfulfillable whole line, using the paid snapshot amount and one stable obligation per disposition. Preserve successful lines. A temporary outage retries/defers rather than immediately declaring a permanent failure.

Example: failed 50-rial line produces one refund operation even with duplicate failure messages. A later failed 30-rial line produces another. Against a 100-rial charge, successful confirmed returns totaling 80 yield PARTIALLY_REFUNDED and net paid 20. UNKNOWN is not returned money; reconcile the same key.

Selected scope: whole lines (no within-line partial-unit refunds), local simulated bank refund operations, append-only refund logs, idempotent reconciliation/review and fulfillment/refund mutual exclusion. A nonexistent reserved unit is corrected/quarantined, not blindly restored to sellable stock. Refund execution follows Q14's recovery-aware work policy; uncertain provider outcomes keep reconciliation independent.

## Q13 — Changed basket and checkout version [selected]

Accept the prior suggestion: reduce a physical quantity to what can be reserved, remove the line when zero remain, return BASKET_CHANGED with reasons, totals, revision and expiry, and require customer confirmation before gateway entry.

Example: old basket has physical quantity 3 plus digital quantity 1; only 1 physical unit remains after hold expiry. Persist a revised unpaid snapshot with physical quantity 1 and updated total; show it for confirmation. Never charge the old total. Physical quantity partial adjustment is selected here; Q12 still refunds whole failed revised lines.

Use immutable checkout revisions and retain the original request-idempotency identity. Paid snapshots never mutate. Catalog price changes on unpaid checkout require a revised snapshot/confirmation. Reserve the confirmed revision's requested quantities atomically; failed acquisition rolls back before creating the next proposed revision. Order creation starts async preparation; actual payment waits for gateway entry. Simple UI is now selected under Q18.

## Q14 — Recovery-aware retries, clocks and review [selected]

Accept the suggested clocks/scheduling with the user's refinement: keep retrying when automatic success remains plausible and affordable. Move to manual review when human change is needed, automatic resolution is unlikely, or repeated attempts would consume excessive resources. Do not treat attempt count alone as evidence of irrecoverability.

Selected baseline: 10-second initial retry delay, exponential factor 2, bounded positive jitter. Initial execution + three automatic retries is a normal cycle; after it, assess continue/defer/review. Bank deadline is first durable bank initiation + 15 minutes, immutable across retries. Reconciliation delay increases to a cap and schedules a deadline lookup. Manual new cycles are explicit, audited and idempotent; duplicate delivery cannot reset them.

Examples:

- Dependency health is red at attempt four: open circuit, preserve next_attempt_at and retry after recovery; no pointless hot loop or mandatory manual review.
- Admin stock discrepancy is confirmed: work cannot self-correct; initiate selected refund/correction rather than infinite fulfillment retry.
- Redis/CPU pressure makes retry expensive: defer automatically with longer delay, reserving capacity for financial outcomes; never drop the accepted workflow.
- Invalid contract/data repeatedly fails after healthy dependency recovery: open a durable review case with reason and attempt history.

Suggested implementation defaults, not measured guarantees: work jitter 0–20% of delay; 60-second bank lookup cap, at most one outstanding lookup per operation, final-deadline lookup with small scheduling tolerance. Use bounded batches, dependency circuits and per-operation age/attempt/cost policy. No fabricated numerical “success probability”; use classified errors, dependency health and observed progress. Reconciliation still obtains authoritative outcome even when an operator is alerted.

## Q15 — Cancellation cutoff [selected]

Accept the suggestion: the first item starting fulfillment closes order cancellation. Under selected Q16 A, cancellation and first start share the Commerce order lock. Cancellation wins → block all items, record intent, release eligible stock once, and schedule refund for captured money. Worker wins → reject cancellation; do not revoke successes.

For UNKNOWN payment accept intent, block item dispatch and reconcile. Later success triggers the full refund, definite failure needs none. Intent/status and financial confirmation remain separate; use CANCELLATION_PENDING while outcome/refund is unresolved.

Example: cancellation reaches Commerce while Billing has committed success but its result is delayed. Commerce records intent; when success arrives, it requests refund instead of dispatching fulfillment. In-flight bank payment stock follows Q11 until its result is known. Pre-bank cancellation needs a Billing no-charge/cancel acknowledgment so a delayed payment command cannot charge after stock release.

## Q16 — Service/data ownership [selected]

Accept option A recommendation: API Gateway, OIDC Identity, Commerce, Billing and Bank simulator, one repository/private network. Commerce owns orders/catalog/inventory and separate digital/subscription/physical modules. Billing owns payment/refund truth. Bank owns simulated provider ledger. Identity owns credentials/access. One PostgreSQL server hosts isolated databases/roles; no cross-owner writes or joins.

Local fulfillment effects, local completion/history/outbox share the Commerce transaction. Billing results reach Commerce through versioned outbox/inbox. Do not split processors into independently owned databases in this MVP. See SERVICE_ARCHITECTURE.md.

## Q17 — Coordinator and reads [selected]

Commerce coordinates durable workflow; commands/results use versioned outbox/inbox. HTTP is bounded and does not run while holding SQL locks. Commerce exposes eventual order progress with source versions/pending transitions; Billing owns authoritative financial records. Replay means current Commerce state, not a globally synchronous snapshot.

Example: Billing succeeds while Commerce is down. On recovery, the result applies once and dispatches items—or a refund if cancellation intent already won. Message identity and operation identity remain distinct. An older result never regresses terminal state.

## Q18 — Identity, API security and simple Persian UI [selected]

Accept maintained OIDC identity-provider recommendation with controlled admin provisioning, customer/admin permissions, token/session lifecycle and authenticated internal services. Proposed provider: Keycloak, subject to package/version setup and the total resource budget. APIs enforce authorization even when called without the UI.

Add a small Persian RTL UI for customers and admins so flows can be seen. Customer screens cover catalog/checkout/payment simulation/order status/refunds/cancel/retry where eligible. Admin screens cover product/inventory management, discrepancies, history and review. Keep visuals/framework simple; no separate frontend security feature program. Normal safe rendering and token handling stay intact; hiding controls is not authorization. See UI_SCOPE.md and SECURITY.md.

## Q19 — Large IRR amounts [selected]

Use whole IRR/rial integers, no toman reinterpretation, no business maximum price/order/refund amount. API money is canonical decimal strings; TypeScript uses exact BigInt operations for integer calculations. SQL uses unconstrained NUMERIC with nonnegative, integer-only, finite checks, not a BIGINT or fixed-precision monetary ceiling. Reject fractions, exponent-form input, NaN and infinities.

Example: a value far above 2^63−1 passes through product, order, bank, refund and UI without rounding. Optimize by parsing once, avoiding Number conversion and unnecessary arithmetic/serialization, and indexing ordinary IDs rather than enormous money values.

Finite payload/CPU/storage and PostgreSQL implementation limits still exist. Resource-based admission/body bounds are separate from a monetary business cap and must return explicit errors rather than truncation. Verify custom NUMERIC migrations/SQL adapters do not inherit an ORM/decimal-library default precision. See SYSTEM_DESIGN.md.

## Q20 — 8 GB / 4-core capacity, admission and scale [selected]

Entire deployment shares 8 GB RAM and 4 CPU cores. Protect accepted workflows; do not discard work under pressure. Admit only what durable storage/worker headroom can support, then return 429/503 with Retry-After for excess new work before acceptance. An ambiguous client response uses its original idempotency key to discover whether acceptance happened.

Prioritize financial results/reconciliation/refunds, cancellation and existing workflow recovery over new orders, broad reads and heavy admin work. Bound execution, pools, queues and retries; deferred accepted work stays in SQL/outbox. No drop-head/TTL deletion of live work, and no reporting success for discarded requests.

Memory/concurrency/admission defaults and a brief scale-up path are in CAPACITY_AND_SCALING.md. These are initial planning values, not measured RPS. Disk budget is unspecified; reserve storage and stop new admission before it fills. Sustained overload cannot be absorbed forever on finite hardware.

## Q21 — Admin changes [selected]

Accept audited adjustments with actor/reason/version/idempotency and explicit discrepancy handling. Deactivate products rather than deleting referenced evidence. New name/price/duration changes apply to new snapshots; unpaid reprice/reconfirmation follows Q13; paid snapshots stay immutable.

Example: inventory reports 2 free + 3 held, admin counts only 1 actual unit. Do not blindly overwrite available or release every hold. Record a reconciliation discrepancy, quarantine disputed stock and identify affected holds/orders. Confirmed paid shortages follow Q01 refunds. Admins cannot bypass captured/refundable budgets. Role management and discretionary refunds are separate permissions, not implied by catalog access.

## Remaining engineering details

No numbered business question remains unanswered. Implementation must record and verify package/provider versions, exact resource watermarks/quotas, session lifetimes, stock-discrepancy allocation order and disk/backup assumptions. These defaults must honor the selected rules; revisit the user only for an actual policy conflict or scope change. Earlier 5–7-day labels require re-estimation for service/auth/refund/UI scope.
