# Foundation API

Base URL: `http://localhost:8080`. Domain routes are under `/api`; health and identity discovery are public. This documents roadmap step 2, not the later checkout/payment workflow or Persian UI.

## Authentication

`GET /auth/config` returns issuer, `tops-web` client ID, `tops-api` audience and Authorization Code + S256 PKCE settings. Keycloak maintains user sessions and refresh rotation. The browser callback/UI is implemented in the UI milestone; no ad hoc password-login endpoint or trusted customer-ID header exists in the API.

For domain calls send `Authorization: Bearer <access token>`. APIs verify RS256 signature, issuer, audience, expiry/issued time, access-token type, subject and realm roles. Gateway and domain service both verify. `GET /auth/me` returns the authenticated subject/roles/client. Role/account changes take effect on newly issued tokens; existing access tokens expire within the configured five-minute lifetime. No immediate-revocation claim is made for stateless access-token verification.

`commerce-service` and `billing-service` use private client-credentials identities with the `service` role. Their credentials are mounted only into their owner. `/internal/identity` is a private authenticated diagnostic, not a client-gateway route; customer/admin tokens do not satisfy service permission. JWKS/token caches do not depend on Redis.

Bootstrap clients/users through `identity-init`, never public self-assignment of admin. `--fixtures` explicitly creates development human users and separate machine clients for automated permission tests. Human demo admin setup requires TOTP; machine fixture tokens are local test credentials, not evidence of a completed browser MFA flow. Never enable/ship the fixture clients as production accounts. No password/token is printed by provisioning or checks.

## Routes

| Method/path | Permission | Purpose |
|---|---|---|
| GET `/api/products` | customer/admin | Active catalog, bounded cursor pagination |
| GET `/api/products/:id` | customer/admin | Active product with exact price and stock view |
| GET `/api/orders/:id` | owner or admin | Foundation order/item snapshot read; nonowner gets 404 |
| GET `/api/admin/products` | admin | Catalog including deactivated products |
| GET `/api/admin/products/:id` | admin | Product including retained inactive evidence |
| POST `/api/admin/products` | admin | Create product; physical inventory starts at zero |
| PATCH `/api/admin/products/:id` | admin | Name/price/duration/metadata change, not product-type mutation |
| POST `/api/admin/products/:id/deactivate` | admin | Deactivate; do not delete referenced data |
| GET `/api/admin/products/:id/audit` | admin | Latest 100 durable audit records |
| POST `/api/admin/inventory/:id/adjustments` | admin | Signed safe-integer stock delta |
| POST `/api/admin/inventory/:id/reconcile` | admin | Actual counted warehouse units with held-stock accounting |
| GET `/api/admin/inventory/:id/discrepancies` | admin | Latest 100 count/hold discrepancy records |
| GET `/api/admin/manual-review` | admin | First 100 open review cases; resolution actions come later |

Catalog query: `limit` defaults 25, maximum 100; pass opaque `nextCursor` as `cursor`. Product timestamps use millisecond precision so cursor round trips cannot repeat sub-millisecond rows. Unknown query/body fields are rejected.

## Mutations and exact money

All mutations require an ASCII `Idempotency-Key` (1–128 letters/digits/`_.:-`) and a meaningful `reason` (5–1000 characters). Keys are scoped by authenticated actor and operation/resource. Same request replays its original mutation result; changed payload under the key returns 409. The create-order current-status replay policy is separate and remains for the checkout milestone.

Whole IRR is a canonical decimal **string**, with no numeric business ceiling. No fractional/exponent/leading-zero/Number input. SQL NUMERIC is unconstrained and validated finite/integer; application sums/products use BigInt. Bodies are limited to 64 KiB, so finite payload/storage/compute limits still apply explicitly.

Create physical product:

```json
{"name":"کالای نمونه","type":"PHYSICAL","priceMinor":"5000000","reason":"Initial catalog setup"}
```

Subscription requires `subscriptionDays` (1–36500 fixed days); digital permits JSON-object `digitalMetadata`. Other types reject those metadata fields. Product type is immutable; deactivate/create a new product for a type change. Creation returns the product UUID, version 1, price string and physical stock version 1/available `"0"`.

Update:

```json
{"expectedVersion":1,"priceMinor":"99999999999999999999999999999999999999999999999999999999","reason":"Catalog price revision"}
```

Adjust stock:

```json
{"expectedVersion":1,"delta":50,"reason":"Warehouse goods received"}
```

Reconcile count:

```json
{"expectedVersion":2,"countedOnHand":1,"reason":"Verified physical warehouse count"}
```

Stock counts/deltas use safe integer JSON numbers, independently of arbitrary-precision money. Responses return stock quantities as decimal strings. Product and inventory versions are separate. Stale versions return 409 with no partial audit/outbox/state change; replay uses the original key/body.

Reconciliation serializes on inventory. When count is below ACTIVE/PAYMENT_PENDING/ALLOCATED holds, set sellable stock to zero, preserve holds, record affected reservation identities/generations, and create a discrepancy/review case. No automatic choice of losing customer or guessed refund. Open discrepancies block relisting until an explicit later resolution workflow. Physical checkout/fulfillment workers must take the same inventory lock before hold changes. Paid order/item snapshots and prior checkout revisions are DB-protected; product edits affect new snapshots only.

Audit and required local event outbox records commit with each successful mutation. Runtime audit/adjustment/history records are append-only by SQL permissions. The owner-local outbox/inbox loop now delivers these notifications with SQL receipts; see [CHECKOUT_AND_OUTBOX.md](CHECKOUT_AND_OUTBOX.md).

## Responses and boundaries

POST mutations return 201; reads/PATCH return 200. Typical failures: 400 invalid request/money/cursor, 401 missing/invalid token, 403 wrong permission, 404 unavailable/nonowned resource, 409 stale version/idempotency/constraint conflict, 413 body limit, 503 database/identity temporarily unavailable. Retry a 503 mutation with the same key. Error responses do not include SQL, tokens or credential values.

Create/order-list/checkout APIs are implemented in step 3; see [checkout contracts](CHECKOUT_AND_OUTBOX.md). Payment/refund execution, fulfillment retry and review-resolution APIs are later. Identity admin/master/management routes remain blocked at the gateway. Real-browser callback/MFA UX and a production TLS deployment require their later verification; the current stack is loopback development HTTP.
