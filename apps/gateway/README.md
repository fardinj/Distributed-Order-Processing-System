# Gateway

Step 7 serves `web/` at `/` and `/auth/callback`, with local assets under `/ui/`; JSON status moves to `/status`. `scripts/build-web.mjs` packages the complete pinned OIDC adapter and Persian font. Browser routing, exact IRR, forms and bounded polling are in separate static modules. See the [UI guide](../../docs/UI_GUIDE.md).

Step 6 adds optional shared Redis quotas, bounded local degraded counters and separate edge/domain concurrency lanes for new traffic and existing-work controls. Authentication stays mandatory when Redis fails. See [limits and failure policy](../../docs/CANCELLATION_RECOVERY_AND_REDIS.md).

Client entry point and controlled Identity reverse proxy. Owns no business database.

`src/main.ts` provides public status/auth configuration, authenticated `/auth/me` and a verified `/api` proxy to Commerce. Backend APIs repeat JWT/role/resource checks. `identity-policy.ts` keeps public Identity paths explicit. User/forwarded identity assertions are stripped/overwritten and validated request IDs propagate.

Provider admin/master/management and internal service routes are not client routes. The web client uses the maintained OIDC adapter with Authorization Code/S256 PKCE and memory-only tokens. No public password-login shortcut, domain DB credentials, unrestricted proxy or custom session table exists here.
