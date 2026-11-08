# Persian customer/admin UI

Open [the local UI](http://localhost:8080/). The gateway serves the static client; no extra always-running service or frontend secret is needed. `/status` keeps the JSON application status and `/health/ready` remains readiness. Follow README setup/upgrade, including migrations and Identity provisioning.

## Sign in

With explicit fixture provisioning (`identity-init --fixtures`), human users are `demo-customer-a`, `demo-customer-b` and `demo-admin`. Generated passwords are in the corresponding gitignored `.local/secrets/user_customer_a_password`, `user_customer_b_password` and `user_admin_password` files. Read your local file; no shared default password is published. The admin completes Keycloak TOTP enrollment when requested. Browser sign-in uses the public `tops-web` client and Authorization Code/S256 PKCE, not service credentials or a password-grant shortcut.

The browser uses pinned `keycloak-js` and in-memory access/refresh tokens, following the [official adapter guidance](https://www.keycloak.org/securing-apps/javascript-adapter). Initial/reload SSO can redirect through the provider. Token refresh happens before API calls; an expired session returns the sign-in view. Post-logout redirect is restricted to the configured public origin. Provider pages and errors remain provider-managed; the app's task screens are Persian.

Provisioning explicitly links the `basic` and `roles` default scopes to existing clients; the web client also receives `profile`. Updating a client representation alone did not attach missing scopes on the existing installation. The [Keycloak administration guide](https://www.keycloak.org/docs/26.8.1/server_admin/) documents the subject mapper in `basic`. API subject/audience/signature checks were retained. Identity proxy waits are bounded at 15 seconds (16-second connection timeout) for cold browser sign-in; domain API timeouts stay at five/six seconds.

## Customer walkthrough

1. Open **فروشگاه**, add quantities (physical up to 100/line; digital/subscription one unit). The cart's amount is approximate until the server revalidates it. Catalog read cache can lag changes by up to two seconds; **تازه‌سازی کالاها** fetches again.
2. **ثبت و بررسی نهایی** creates the server checkout and five-minute reservation. The countdown is a client-clock hint; the server owns expiry. After a lost response or temporary rejection, retry the same operation. The client retains its pending operation key for the same actor/path/payload across retry; it never assumes an unseen order was discarded. Order lists remain the recovery path if the tab/cart is lost.
3. Expired stock/price changes create a new basket revision. Read previous/new quantity and unit price, then choose **تأیید سبد تغییر‌یافته**. An empty/unavailable basket cannot be forced into payment.
4. **رفتن به پرداخت** opens the local simulation confirmation. **تأیید و آغاز پرداخت** invokes the real server payment-entry API. There are no success/failure URL flags or public fault controls. Once payment owns the reservation, the original checkout timer does not release it.
5. Order detail separates workflow, charge result, confirmed return and pending return. UNKNOWN explicitly stays under lookup. Typed effects show access grants, fixed subscription extensions and shipment references; a resolved failed-line order is not mislabeled all-success.
6. Eligible **لغو سفارش** requires a reason and server version; after first fulfillment start it conflicts. Paid/unknown cancellation waits for authoritative settlement. **تلاش دوباره** applies only to due eligible work; succeeded/refund-resolving lines do not rerun.
7. Read bounded attempt pages, refund pages and refund logs. Recent order events are Persian summaries with raw type/metadata inside expandable technical detail. Manual refresh fetches the latest 100 order events.

Active order views poll every 10 seconds, stop for terminal states, pause in hidden tabs/while forms or dialogs are in use, and back off after errors/429/503 up to 60 seconds plus server Retry-After. There is no per-row polling. A successful authoritative read replaces stale uncertainty in the display; it never manufactures success locally. Tables scroll locally on narrow screens, with a keyboard-focusable scroll region and a Persian hint.

## Admin walkthrough

* **مدیریت کالا:** create physical/digital/subscription products, edit price/name/type-specific metadata, deactivate without deleting history, inspect audited changes. Exact rial inputs accept Persian/Arabic digits and remain decimal strings. Type is immutable. Search a product by its ID; lists use bounded cursor pages.
* Inventory adjustments and physical counts open a reasoned confirmation dialog using the last fetched version. A low physical count can quarantine sales and record affected reservation/item IDs. **سوابق اختلاف موجودی** links each affected item to its order. A simple stock increment cannot erase a recorded shortage.
* **مدیریت سفارش‌ها:** bounded list/search by order, customer or item UUID. The new `GET /api/admin/orders?limit=25&cursor=UUID&query=UUID` is admin-only; it returns exact amounts and uses a forward migration for global date/id paging. Ownership rules on customer APIs remain unchanged.
* On a paid unfulfilled physical line, **ثبت کسری و بازپرداخت** requires a recorded discrepancy/current generation and refunds the whole line. It cannot refund successful work or choose arbitrary money. Successful sibling items stay fulfilled.
* **بررسی دستی:** inspect current case/item/refund and open an audited retry cycle for RECOVERY_COST after repairing the cause. Stock review leads to the guarded shortage action. A definitive provider refund decline stays owed; the UI offers no force-success or fresh financial key.

## Source and defaults

`apps/gateway/web/` contains `app.js` (routing/session/polling), `auth.js`, `api.js` (bounds/errors/pending keys), `catalog.js`, `orders.js`, `admin.js`, `view.js`, `format.js`, HTML and CSS. `scripts/build-web.mjs` copies the static client, complete pinned adapter modules/licenses and local Vazirmatn files into the selected gateway image. Browser dependencies and Playwright are development-only and pruned from server dependencies after assets are built. PRODUCT.md and DESIGN.md describe scope and the shipped visual rules.

There is no business money ceiling. Formatting/grouping runs on strings in linear work; only bounded counts become Number. Very long amounts and machine IDs wrap/scroll locally. HTTP/computed-work limits still apply before acceptance. Hash routes are UI navigation, never authorization; direct calls still require verified server roles/ownership. API failures have Persian explanations and correlation IDs. Redis outage mode is advertised while database safeguards and authentication remain active.

The steady nine-service Compose resource envelope stays unchanged. Browser verification is an opt-in tools container (1,536-MiB cap) outside that steady service budget. Do not run build/load/browser tooling alongside a saturated eight-GB benchmark and claim the same workload capacity.

Run `docker compose --profile tools run --rm --build ui-checks` for real Chromium checks. It transparently forwards its localhost test origin to the gateway, performs a real human customer login, and uses a real scoped fixture JWT in a test-only intercepted adapter for admin UI actions. The production UI has no fixture switch. Human admin MFA enrollment is preserved and was not automated. Private SQL fixtures control only the test orders' clocks/delays; none are public endpoints. Captures/results are gitignored under `.local/verification/ui/`. See [UI_VERIFICATION.md](UI_VERIFICATION.md) for actual evidence and remaining limits.
