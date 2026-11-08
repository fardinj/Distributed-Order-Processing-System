# Requirements and accepted decisions

Status: Q01-Q21 choices are selected. Steps 1-7 are implemented as of 2026-11-06. Recovery/Redis contracts remain in [CANCELLATION_RECOVERY_AND_REDIS.md](CANCELLATION_RECOVERY_AND_REDIS.md). The Persian UI, static-client engineering choices and executed evidence are in [UI_GUIDE.md](UI_GUIDE.md) and [UI_VERIFICATION.md](UI_VERIFICATION.md). Step 8 evidence/load work is next.

## Assignment requirements

Use Node.js/TypeScript, NestJS, PostgreSQL, Redis, RabbitMQ and Prisma. Demonstrate authoritative pricing, safe money, idempotent requests/consumers, asynchronous typed processors, no overselling, transactions/locking, failure recovery, event history, migrations, API docs, diagrams, setup and meaningful concurrency/failure evidence. PostgreSQL remains business authority; RabbitMQ delivery is at least once. User-selected additions include refunds, authenticated/admin APIs, separated services and a simple Persian UI.

## Decision register

| ID | Question | Selected policy |
|---|---|---|
| D01 | Q01 C | Keep successful items and refund failed items. List refund records/logs; financial summary distinguishes pending returns, PARTIALLY_REFUNDED and REFUNDED. Policy inspiration: Digikala policy as described by the user, not independently verified current policy. |
| D02 | Q02 B | Final checkout reserves physical stock for five minutes. After expiry, gateway entry atomically rechecks/reacquires stock; unavailable items produce an updated basket and require confirmation. D13 adds the payment-stage exception. |
| D03 | Q01/Q02 | Paid physical-stock discrepancies are assumed to arise from admin count/data mistakes, not ordinary customer contention. Customer cancellation is a separate refund reason. |
| D04 | Q03 A | Timeouts mean UNKNOWN. Reconcile the original operation using increasing delays until bank outcome. Simulator fails still-pending operations after 15 minutes; committed success is immutable and failed operations cannot later charge. |
| D05 | Q04 A, refined Q14 | Retry transient recoverable work; never rerun successes. Initial attempt + three exponential/jittered retries is the normal cycle, followed by recoverability/cost assessment rather than unconditional manual escalation. D16 defines deferral/continuation/review. |
| D06 | Q05 B | Allow paid-order cancellation before fulfillment starts; stop eligible work and return captured money. |
| D07 | Q06 A | Customer/operation-scoped idempotency: same logical request returns same order ID/current status; changed payload conflicts. Authenticated identity defines the customer. Replays never renew holds or restart completed work. |
| D08 | Q07 | Positive integer physical quantities; nonphysical quantity 1; merge duplicate physical lines, reject duplicate nonphysical lines. Subscription duration is fixed days; extend from max(expiry, database time), once per paid item. |
| D09 | Q08 | Digital/subscription/shipping simulations commit local effects and local completion atomically. Bank simulator commits independently. Use per-owner transactional outbox/inbox for durable cross-service commands/results. |
| D10 | Q09 | Redis cache, short-lived scheduler lock and rate limiter. Redis outage bypasses cache/lock with SQL guards; API remains available with explicitly weaker bounded per-instance quotas. |
| D11 | Q10 | Authenticated users and admin-controlled catalog/inventory; API authorization, ownership checks, audit and service identities are mandatory. No trusted-user bypass. |
| D12 | Deployment | Separate services in one private application network, with a client-facing API gateway. API gateway differs from bank/payment gateway. |
| D13 | Q11 | At gateway entry, atomically renew/reapply the reservation and promote it to PAYMENT_PENDING. Keep stock held until authoritative payment outcome. Success converts it to paid ALLOCATED stock; failure releases it once. UNKNOWN keeps the hold. Five-minute checkout expiry no longer applies after promotion. |
| D14 | Q12 | Prompt whole-failed-line refunds; stable obligation/operation keys, local simulator, durable attempts/logs and reconciliation. Freeze fulfillment for refund-resolving lines. Correct/quarantine miscounted units rather than relisting phantom stock. |
| D15 | Q13 | Reduce unavailable physical quantities to available units; remove a line if none remain. Return BASKET_CHANGED with reasons, totals, revision and expiry; require confirmation. Version unpaid checkout snapshots; paid snapshots stay immutable. |
| D16 | Q14 | Persist bank deadline from first durable initiation; base work delay 10s, factor 2, bounded positive jitter; capped increasing reconciliation and a deadline lookup. Continue/defer when recovery is plausible and cost acceptable; manual review when automatic finalization is unlikely or repeated work would be excessive. Manual new cycles are explicit, audited, idempotent. |
| D17 | Q15 | Cancellation cutoff is the first item starting fulfillment. Shared Commerce order lock chooses cancellation versus first start. Accept cancellation intent for UNKNOWN payment: block items, reconcile, refund on success, no refund on definite failure. Accepted intent is not confirmed returned money. |
| D18 | Q16 A | Coarse services: API Gateway, OIDC Identity provider, Commerce (orders/catalog/inventory and three processor modules), Billing (payments/refunds), Bank simulator. One repo, one PostgreSQL server with separate owned databases/runtime roles; no cross-owner writes/joins. |
| D19 | Q17 A | Commerce is durable coordinator. Use versioned commands/results through outbox/inbox, bounded HTTP reads, order-owned eventual progress projections and source versions. Billing owns financial truth; replay returns current Commerce status, not a global instantaneous snapshot. |
| D20 | Q18 | Maintained OIDC identity provider, controlled admin provisioning, customer/admin API permissions and service authentication. Add a simple Persian RTL customer/admin UI to demonstrate flows. Keep frontend scope small; all security decisions are enforced by APIs, not hidden buttons/client validation. |
| D21 | Q19 | IRR, whole rial, arbitrary-precision nonnegative integer money as decimal strings. No product/business monetary ceiling. Use SQL unconstrained NUMERIC with integer/finite constraints and exact application arithmetic; technical payload/storage/compute limits still apply. |
| D22 | Q20 | Entire deployed stack has 8 GB RAM and 4 CPU cores. Protect accepted workflows; reject excess new work before acceptance with explicit retryable responses. Durable deferral, bounded concurrency and backpressure preserve in-flight financial/fulfillment processing. Plan measurements and scale-up path in CAPACITY_AND_SCALING.md. |
| D23 | Q21 A | Admins use audited/versioned/idempotent product and inventory adjustments. Deactivate referenced products rather than deleting evidence. New product values apply to new snapshots; unpaid changes require reconfirmation; paid snapshots never change. |

## Interpretations needed for correctness

- D13 supersedes the earlier proposal to release every hold after five minutes: that timer protects checkout only. Paid stock is not returned to sellable inventory merely because payment succeeded; it remains ALLOCATED until shipment consumption or an eligible release/correction.
- Fifteen minutes is the bank's pending-operation deadline, not proof that a locally unreachable payment failed. Keep its stock protected until the terminal result is known. Persistent unknowns remain visible and recoverable; do not release by guessing.
- D16 refines D05: attempt four is a decision checkpoint, not an unconditional manual-review trigger. Resource pressure defers durable work; it does not discard it or automatically require human intervention.
- API availability during Redis failure does not prohibit overload rejection. Auth stays enforced; admitted work stays durable. New overloaded requests may receive 429/503 before admission.
- D21 removes business amount caps, not finite machine limits. Do not silently round, wrap, clamp, or reinterpret rial as toman. Resource-based payload rejection is explicit and precedes admission.
- The UI is for demonstration, without a separate frontend security project. Normal framework escaping/token handling remains; UI cannot bypass protected APIs or decide payment/refund success.

## Implementation defaults and residual details

The business choices are selected. Engineering defaults in SYSTEM_DESIGN.md, CAPACITY_AND_SCALING.md, SECURITY.md and UI_SCOPE.md remain tunable until measured. Examples: jitter bound, reconciliation cap, resource watermarks, precise session lifetimes and provider package/version. Keycloak is the proposed OIDC provider, not a new requirement from the user. Disk capacity/durability and sustained benchmark throughput are unspecified; do not claim unlimited durable backlog or a measured capacity.

No additional business-policy approval is implied by routine implementation choices. Escalate actual contradictions or changed scope; otherwise record the chosen defaults and evidence.

Step 8 operational default: planned-downtime, quiescent four-owner PostgreSQL backups with separate-volume restore verification; Redis is rebuildable and retained SQL outbox/inbox identities reconstruct missing broker handoffs. No HA, continuous WAL archive, encrypted off-host backup or production RPO/RTO is assumed. [Runbook](OPERATIONS.md) and [execution evidence](SUBMISSION_VERIFICATION.md) give exact limits. The 8-GB/four-core server budget remains the target; load was executed under matching component caps on a larger shared host and does not substitute for dedicated-host measurement.
