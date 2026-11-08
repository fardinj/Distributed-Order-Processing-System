# Repository workflow

- Follow `docs/GIT_WORKFLOW.md`: start `feature/*` or `fix/*` from `develop`; do not implement directly on `main` or `develop`. Use scoped Conventional Commits.
- Keep changes on their working branch until integration/review. Do not publish or rewrite shared history implicitly.
- Use Docker Compose for builds/checks when host Node is unavailable. Preserve existing volumes and local credentials; never reset data to make a test pass.
- Keep service ownership private: Commerce, Billing, Bank and Identity have separate database roles. Shared runtime contains no domain models.
- Money is whole IRR as exact decimal strings/BigInt and unconstrained NUMERIC; do not introduce a business amount ceiling or float conversion.
- Record executed commands/results separately from planned verification. Credentials, generated clients, local state and build outputs remain ignored.
