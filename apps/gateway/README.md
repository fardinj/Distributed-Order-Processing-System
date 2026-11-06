# Gateway

Step 6 adds optional shared Redis quotas, bounded local degraded counters and separate edge/domain concurrency lanes for new traffic and existing-work controls. Authentication stays mandatory when Redis fails. See [limits and failure policy](../../docs/CANCELLATION_RECOVERY_AND_REDIS.md).

Client entry point and controlled Identity reverse proxy. Owns no business database.

`src/main.ts` provides public status/auth configuration, authenticated `/auth/me` and a verified `/api` proxy to Commerce. Backend APIs repeat JWT/role/resource checks. `identity-policy.ts` keeps public Identity paths explicit. User/forwarded identity assertions are stripped/overwritten and validated request IDs propagate.

Provider admin/master/management and internal service routes are not client routes. The web client uses maintained OIDC Authorization Code/S256 PKCE; browser callback/Persian UI comes later. No public password-login shortcut, domain DB credentials, generic unrestricted proxy or server-side session table exists here.
