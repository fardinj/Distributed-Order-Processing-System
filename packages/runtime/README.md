# Shared runtime

Technical utilities: validated secret-file configuration, schema-aware dependency health, logs/correlation/shutdown, OIDC JWT/role guards, cached service credentials, canonical request hashing and exact integer IRR arithmetic. No order/payment models or business transitions belong here.

`outbox.ts` implements bounded transport using an owner-supplied SQL store and handler: publisher confirms/mandatory routing/leases, durable inbox staging, receipt/effect transactions, backoff and quarantine. Each owner keeps its own schema, pool and domain validation; this utility never joins owner databases. See [transport contracts](../../docs/CHECKOUT_AND_OUTBOX.md).

Each app imports `RuntimeModule.forRoot(config)`. APIs are authenticated by default; explicit `@Public` is limited to health/status/config. Roles and resource ownership remain explicit at controllers/queries; internal service permission also checks allowed client identity. Required/optional health semantics are shared, pools/credentials remain per owner. Unit tests cover readiness, claims, routing, hashing and money.
