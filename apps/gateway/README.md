# Gateway

Client entry point and controlled Identity reverse proxy. Owns no business database.

`src/main.ts` assembles the service; `src/identity-policy.ts` keeps public Identity paths explicit and testable. Root Compose publishes this app only. API routing/session/authorization integration and static Persian UI serving are subsequent milestones; no generic unrestricted upstream proxy is provided.
