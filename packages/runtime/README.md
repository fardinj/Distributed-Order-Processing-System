# Shared runtime

Technical bootstrapping only: validated configuration/secret-file reads, dependency health, structured logs, correlation IDs and graceful close. It must not contain order/payment models or business state transitions.

Each app explicitly creates its configuration and imports `RuntimeModule.forRoot(config)`. Required/optional dependency semantics are shared; database credentials and resources remain per owner. Tests are in `tests/runtime.test.mjs`.
