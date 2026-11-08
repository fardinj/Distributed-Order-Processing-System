# API reference and request collection

Local base URL: `http://localhost:8080`. [api/tops.http](../api/tops.http) contains editable requests with placeholders; never commit bearer tokens. The Persian [UI](UI_GUIDE.md) is the simplest interactive demo. Human login uses Authorization Code + S256 PKCE; no password-grant customer endpoint or trusted identity header is provided. Local test clients are provisioned explicitly with `identity-init --fixtures`; their credentials stay private.

All `/api` routes require an RS256 access token for `tops-api`, validated at Gateway and Commerce. Customer requests derive ownership from `sub`; admin routes require the admin role. Nonowned order/item/refund resources return 404. Caller-supplied customer IDs, prices, payment results, roles and unknown fields are rejected. All amounts are whole IRR **decimal strings**, including values beyond 64-bit range. Stock quantities are bounded integers on input and strings on read. Body limit: 64 KiB; order 1–50 input lines, physical merged quantity 1–100, nonphysical quantity one. Financial snapshots additionally have a 250,000-byte preacceptance bound.

## Public and identity

| Method/path | Contract |
|---|---|
| GET `/` | Persian customer/admin app |
| GET `/status` | Application metadata |
| GET `/health/live`, `/health/ready` | Process liveness and dependency readiness; readiness can be degraded with Redis down |
| GET `/auth/config` | OIDC issuer/client/PKCE configuration |
| GET `/auth/me` | Verified principal; token required |
| `/identity/realms/tops/...` | Allowlisted OIDC discovery/login/token/logout endpoints; admin/master/management paths blocked |

## Catalog and operations

| Method/path | Permission / body / result |
|---|---|
| GET `/api/products`, `/api/products/:id` | Customer/admin; active catalog |
| GET `/api/admin/products`, `/api/admin/products/:id` | Admin; includes inactive products |
| POST `/api/admin/products` | Admin; `{name,type,priceMinor,reason}`; SUBSCRIPTION also requires `subscriptionDays`, DIGITAL optionally `digitalMetadata`; returns version 1 |
| PATCH `/api/admin/products/:id` | Admin; `{expectedVersion,reason,...changed fields}`; type immutable |
| POST `/api/admin/products/:id/deactivate` | Admin; `{expectedVersion,reason}`; retains history |
| GET `/api/admin/products/:id/audit` | Admin; latest 100 audit entries |
| POST `/api/admin/inventory/:id/adjustments` | Admin; `{expectedVersion,delta,reason}`; signed safe-integer delta |
| POST `/api/admin/inventory/:id/reconcile` | Admin; `{expectedVersion,countedOnHand,reason}`; count cannot silently invalidate holds |
| GET `/api/admin/inventory/:id/discrepancies` | Admin; latest 100 discrepancies |
| GET `/api/admin/orders` | Admin; paginated operational order summaries |
| GET `/api/admin/manual-review` | Admin; `{items,nextCursor}` |
| GET `/api/admin/manual-review/:id` | Admin; case, order/item and available action evidence |
| POST `/api/admin/orders/:id/items/:itemId/shortage` | Admin; `{expectedGeneration,reason}`; guarded permanent physical-line disposition/refund obligation |

Catalog pagination defaults 25, maximum 100, opaque cursor. Orders/review/refund/attempt lists use their returned cursor; do not fabricate a cursor from a timestamp. Product and inventory versions are independent. [Foundation contract](API_FOUNDATIONS.md) gives detailed DTO validation and audit semantics.

## Orders and financial projections

| Method/path | Contract |
|---|---|
| POST `/api/orders` | Customer; `{items:[{productId,quantity}]}`; required `Idempotency-Key`; creates canonical snapshot, SQL admission slot, five-minute holds and outgoing event atomically |
| GET `/api/orders` | Customer/admin's own order list; `limit` and `cursor` |
| GET `/api/orders/:id` | Owner/admin; current checkout/workflow versions, items, fulfillment evidence, financial projection and available actions |
| POST `/api/orders/:id/checkout/refresh` | Owner; `{expectedRevision}`; expired basket reacquisition may produce a new `BASKET_CHANGED` revision |
| POST `/api/orders/:id/checkout/confirm` | Owner; `{expectedRevision}`; customer confirms the revised snapshot |
| POST `/api/orders/:id/payment` | Owner; `{expectedRevision}`; promotes holds and commits one stable payment request; async result |
| POST `/api/orders/:id/cancel` | Owner; `{expectedVersion,reason}`, required key; version is `workflowVersion`; eligibility ends at first fulfillment start |
| POST `/api/orders/:id/items/:itemId/retry` | Owner for eligible retry; admin for eligible recovery-cost review; `{expectedGeneration,expectedRetryVersion,reason}`, required key |
| GET `/api/orders/:id/items/:itemId/attempts` | Owner/admin; chronological bounded attempts |
| GET `/api/orders/:id/refunds` | Owner/admin; confirmed/pending obligations and exact amounts |
| GET `/api/orders/:id/refunds/:dispositionId/logs` | Owner/admin; bounded durable return observations |

Read the latest response before using a version/generation. Refresh/confirm/payment use revision guards and stable workflow identity, rather than generating a new charge for every HTTP retry. Admin writes, cancellation and manual retry require actor/resource-scoped ASCII `Idempotency-Key` (1–128 letters/digits/`_.:-`) and a 5–1000-character reason. Same mutation key/body replays its saved result; changed body conflicts. Create-order replay returns the **same order's current status** without renewing holds or adding capacity. A 201 acknowledges a committed local transition; it does not mean bank success, delivery or refund confirmation.

Payment/return projection statuses include PENDING, UNKNOWN, SUCCEEDED and FAILED; fulfillment/order status and the financial refund summary are separate fields. A confirmed partial return produces PARTIALLY_REFUNDED; pending money is never counted as returned. Use returned `actions` and current state; a stale client action can still receive 409. See [checkout](CHECKOUT_AND_OUTBOX.md), [payment](PAYMENTS_AND_BANK_RECOVERY.md), [fulfillment/refund](FULFILLMENT_AND_REFUNDS.md) and [recovery](CANCELLATION_RECOVERY_AND_REDIS.md) for complete state rules.

## Filtering, complete history and metrics

Order lists (`/api/orders` and `/api/admin/orders`) accept `status`, `createdFrom` and `createdTo` alongside pagination. Dates must be ISO-8601 timestamps with a timezone; the interval is **[createdFrom, createdTo)**. Customer lists remain owner-scoped. Admin UUID `query` can be combined with these filters. Keep the same filters while following `nextCursor`; unknown states, malformed dates and reversed/empty date intervals return 400.

`GET /api/orders/:id/events?limit=25&cursor=UUID` returns `{items,nextCursor}` for owner/admin, oldest first. It exposes the complete retained history rather than the latest 100-event detail window. Each event has a string `sequence`; cursors must belong to this order. New events use a database identity sequence so events in one transaction retain insertion order. Existing history is preserved with backfilled identities; it cannot recover information never recorded before this migration. New fulfillment attempts include `ItemProcessingStarted`, and physical effects include `ShipmentCreated` with their reference, atomically with the effect/attempt. A rolled-back crash leaves no falsely committed start/effect event.

Admin-only `GET /api/admin/metrics` returns Commerce metrics in Prometheus text format. Commerce and Billing also expose private service-authenticated `GET /internal/metrics`; Gateway does not route those private endpoints. Metrics contain aggregate counts/process values, no order/customer labels or amounts. See [operations](OPERATIONS.md) for caching, definitions and collection limits.

## Errors, bounds and retries

400 invalid input, 401 missing/invalid/expired token, 403 role denied, 404 unavailable/nonowned resource, 409 stale version/key conflict/current-state conflict, 413 body too large, 429 caller quota, 502 upstream unavailable, 503 capacity/database/identity unavailable. Retry transient failures with exponential delay/jitter and the **same identity/key/body**. After an ambiguous create response, replay the same key to discover SQL acceptance; never assume timeout means rejection. Re-read versions after a definite 409 before deciding a new action.

Gateway bounds ordinary and recovery concurrency separately; replies include `Retry-After` for quota/capacity errors. `X-Rate-Limit-Mode: shared` uses Redis; `local-degraded` documents weaker per-Gateway quotas during outage. Read/admin/new/recovery quotas are independent; see [limits](CANCELLATION_RECOVERY_AND_REDIS.md). Redis loss never relaxes authorization or SQL correctness. Responses/logs carry `X-Request-Id`; clients may provide an ASCII correlation ID up to 80 characters.

## Private Bank API

Only Billing's authenticated service identity may call `/internal/charges/init`, `/internal/charges/:key`, `/internal/charges/:key/execute`, `/internal/charges/:key/cancel` and corresponding refund endpoints. These are private service routes and are absent from Gateway routing. Stable charge identity is `payment:<order UUID>`; exact amount/currency and immutable bank state guard replay. Provider outcomes/fault rules are private test fixtures, never client fields. Full contracts: [payments](PAYMENTS_AND_BANK_RECOVERY.md), [refunds](FULFILLMENT_AND_REFUNDS.md).
