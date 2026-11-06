# Bank simulator

Independent provider-ledger boundary with its own database/credentials. Stable charge/refund operation identities and the 15-minute pending-payment deadline will be implemented in the payment milestone.

The current entry point exposes health only. It does not yet simulate payments or claim exactly-once charging. Prisma configuration/schema is private to this service. No broker or other owner's database credentials are mounted.
