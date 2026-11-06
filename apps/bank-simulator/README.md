# Bank simulator

Independent provider-ledger boundary with its own database/credentials. Stable charge/refund operation identities and the 15-minute pending-payment deadline will be implemented in the payment milestone.

Private schema/migrations now contain charge/refund ledgers and deterministic simulation-rule fixtures, unconstrained IRR, immutable operation/terminal identities and a fixed 15-minute pending deadline guard. Runtime API currently exposes health and protected service-identity diagnostics, not execution of those rules.

No exactly-once charging claim is made before the payment milestone implements/reconciles the stable operation protocol. No broker/other-owner DB credentials or migrator password are mounted into runtime.
