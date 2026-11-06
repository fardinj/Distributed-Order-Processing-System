# Shared runtime

Technical utilities: validated secret-file configuration, schema-aware dependency health, logs/correlation/shutdown, OIDC JWT/role guards, cached service credentials, canonical request hashing and exact integer IRR arithmetic. No order/payment models or business transitions belong here.

Each app imports `RuntimeModule.forRoot(config)`. APIs are authenticated by default; explicit `@Public` is limited to health/status/config. Roles and resource ownership remain explicit at controllers/queries; internal service permission also checks allowed client identity. Required/optional health semantics are shared, pools/credentials remain per owner. Unit tests cover readiness, claims, routing, hashing and money.
