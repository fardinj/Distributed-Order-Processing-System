# Security requirements and proposed controls

Status: Q18 selects maintained OIDC identity/API security and a simple Persian UI; Q20 selects an 8 GB/4-core host with backpressure; Q21 selects audited admin adjustments. This combines implemented API foundations with later workflow controls, not a completed security audit. Executed evidence is in FOUNDATIONS_VERIFICATION.md. Package versions, session lifetimes and measured limits remain engineering defaults. API security is authoritative; no separate client-side security feature program is added.

## Access and ownership

Require authentication by default on customer/admin domain APIs. Explicit public exceptions may include login and limited liveness endpoints; document each. Derive customer identity from verified authentication context; reject/ignore identity and role headers supplied by clients. Services validate audience/issuer/signature/expiry for chosen tokens and enforce resource ownership even behind the gateway. Authentication and authorization are distinct responsibilities ([NestJS authorization](https://docs.nestjs.com/security/authorization)).

Customers can access their own orders and permitted retry/cancellation actions. Admin permissions cover catalog/inventory data management and explicitly granted review actions; do not assume every admin can alter roles, bypass stock guards or issue discretionary refunds. Bind item, order, payment and refund references to the authorized owner. Test object- and function-level authorization on list, detail and mutation APIs.

No public endpoint assigns admin privileges. Bootstrap privileged access through a controlled operation with no committed default password. Audit changes with actor, reason, target, before/after or adjustment, timestamp and correlation ID. Sensitive role/credential changes use explicit provider revocation/step-up behavior.

## Identity and session choices

Use the maintained Keycloak OIDC provider rather than building credentials/cryptography in Commerce. Provider-managed passwords use supported secure hashing; benchmark login within its allocated resource budget. For custom password handling, follow maintained-library/OWASP guidance rather than a fast general-purpose hash ([password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)).

Configure short-lived access, refresh rotation/reuse handling, logout/revocation and admin step-up/MFA using the provider. Record exact lifetimes as implementation defaults. Redis is not the only store needed to verify identity/revoke privileged access; document disabled-account/permission-change propagation. Provider service identities or equivalent scoped credentials authenticate internal calls and broker producers.

Current APIs use signed bearer access tokens with a five-minute lifetime, cached provider JWKS and domain ownership/role checks. Sessions and refresh rotation belong to Keycloak; revocation is bounded by access-token expiry, not immediate. The public browser client requires authorization code with S256 PKCE; callback/UI implementation is step 7. No gateway session store or cookie BFF is implemented or required by this baseline. Any later cookie flow must include CSRF protection and appropriate Secure/HttpOnly/SameSite attributes. TLS remains required for external deployment. See [API_FOUNDATIONS.md](API_FOUNDATIONS.md) for implemented contracts.

## Inputs and business actions

Validate DTOs/allowlisted fields; reject client-owned attempts to set prices/status/stock/admin roles. Parameterize raw SQL. Bound bodies, work size, quantities, pages and query filters, but impose no business IRR monetary maximum. Parse exact integer strings and fail resource/implementation limits explicitly without rounding. Errors reveal no internal stacks or credentials.

Keep idempotency keys customer/operation scoped, with bounded size. Bind payment commands to an authorized immutable order revision/amount. Only the financial owner can emit authoritative payment/refund results. Development fault controls and simulator outcome overrides are not public customer features. Authenticate simulator callbacks/requests using the selected service-identity contract; do not trust an arbitrary success payload.

Catalog mutations are admin-only; immutable snapshots protect existing paid orders. Inventory adjustments must use the same database safeguards as reservations and require reason/version/idempotency checks. Hard deletion of referenced financial/history evidence is not ordinary CRUD.

## Infrastructure and degraded operation

Use distinct service/DB/broker credentials, least-privilege runtime roles and separate migration privileges. Scope RabbitMQ publish/consume permissions; do not expose management credentials to application clients. Keep databases, Redis, broker and internal services private. Never commit real secrets; supply environment examples with placeholders, restricted runtime secrets and rotation guidance.

Redis outage policy is selected: bypass cache and scheduler lock with SQL safeguards, keep API available, use explicitly weaker rate limiting. Proposed fallback is bounded per-instance counters with TTL/key caps, plus gateway connection/body/concurrency bounds. It cannot promise a global quota and may reset on restart. Apply tighter configured protections to login/admin operations while preserving the selected availability policy. Emit degraded-mode metrics and document per-replica behavior.

Security checks and identity verification remain enforced during Redis outages. Dependency unavailability may still fail an operation safely if its authoritative service/DB is required; keeping the API available does not mean fabricating successful authentication or accepting unsafe writes.

## Evidence and performance

Step 6 implements the selected Redis outage behavior and public action guards. See [CANCELLATION_RECOVERY_AND_REDIS.md](CANCELLATION_RECOVERY_AND_REDIS.md) for exact quotas, bounded fallback/overflow keys, cache staleness, owner-token locking and action ownership/version/idempotency contracts. `X-Rate-Limit-Mode` advertises shared/local-degraded enforcement. Auth stays mandatory. The storage monitor uses an unprivileged UID, read-only filesystem metadata access and Commerce-only credentials; it cannot read PostgreSQL-owned data files.

Test expired/forged/wrong-audience tokens, identity spoofing, customer cross-access, admin escalation, direct internal-service access, forged broker/result messages, SQL injection inputs, oversized work, rate-limit exhaustion and Redis failure. Test admin corrections racing with reservations. Include secret/log redaction and permission-aware refund/history responses.

Benchmark with auth, ownership checks, audit and bounds enabled on the selected 8 GB/4-core host. Use indexed owner filters, cached public verification keys where appropriate, reusable connections and bounded worker/login concurrency. CAPACITY_AND_SCALING.md defines initial budgets/admission; measured throughput is not yet known. Dependency/secret scans and backup/restore evidence belong in delivery, with actual results distinguished from plans.

Client-side scope is intentionally small: normal framework escaping and provider/session integration, no custom frontend security product. Hidden controls and client validation never authorize operations. Reject new overload before acceptance while protecting admitted workflows; Redis outage does not disable authentication/authorization.
