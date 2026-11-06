# Step 7 executed verification

Executed on 2026-11-06 using existing Docker Desktop volumes and the `feature/persian-operations-ui` branch. No production data reset, credential replacement, ledger deletion or remote push was performed. The feature is integrated into local develop through scoped commits and a non-fast-forward merge.

## Executed checks

| Check | Observed result |
|---|---|
| `docker compose --profile bootstrap run --rm --build migrate` | Forward Commerce migration 012 adds global order date/id cursor index. Commerce/Billing/Bank migration counts are 12/8/6; no older SQL was edited. |
| `docker compose --profile bootstrap run --rm identity-init --fixtures` | Existing clients explicitly receive required default-scope associations. Public web client retains S256, exact callback/logout origins and no password grant. Persian provider locale enabled; human admin TOTP requirement retained. |
| `docker compose --profile tools run --rm --build tools npm test` | Current source builds, copies complete adapter/font assets and passes all 14 tests. New tests preserve every digit of a 60,000-digit IRR string and reject fractional/unsafe counts. |
| Chromium full UI suite, followed by `ui-checks --flows-only` under pinned Node 24 | Real human customer Authorization Code/PKCE login, admin forms, lost-response replay, checkout revision, payment uncertainty, cancellation/refunds, shortage and review flows passed against live APIs. Final DOM checks passed without recapturing a third visual matrix. |
| `ui-checks --session-only` | Real provider logout returned to the signed-out Persian view; no access/refresh token persisted. |
| `ui-checks --capture-only` | Final six desktop/mobile captures passed document-overflow checks, Persian history assertions and 700px/nowrap mobile table assertions. Prior result IDs were reused rather than generating new work for visual corrections. |
| `docker compose --profile tools run --rm --build foundation-checks` | Current OIDC/ownership/admin boundaries, exact IRR, versioned inventory, SQL financial guards and deactivation/pagination passed. Review discovery now follows cursor pages rather than assuming the new case is in the first page of retained history. |
| `docker compose --profile tools run --rm --build tools node scripts/smoke.mjs` | Service readiness, correlation, own-DB/no-cross-DB/no-DDL permissions, broker permissions/routed confirms, Identity proxy boundary and authenticated Redis passed. |
| `docker compose --profile tools run --rm tools node scripts/reconcile-admission.mjs` | `previousUsed:4, used:4, capacity:200`; retained unsettled slots were not cleared. |
| Formatting and migration rerun | Prettier, `git diff --check`, schema validation and no-pending-migrations checks passed. Production pruning reported zero dependency vulnerabilities. |

The browser runner is opt-in, uses the pinned Playwright image and copies Node 24.15.0 from the build stage. Its loopback TCP forwarder preserves the configured localhost origin while routing through the actual gateway. During iteration the same source was bind-mounted into the runner; the reproducible tools image includes that script. Normal `ui-checks` runs flows and captures; `--flows-only` skips new PNGs, `--capture-only` requires the prior results file, and `--session-only` checks sign-in/out.

## What the browser actually exercised

* A human `demo-customer-a` signed in through Keycloak's browser forms and S256 code flow. `/auth/me` accepted the resulting subject/role/audience; admin controls remained hidden. Direct access by another customer returned 404; non-admin global order search returned 403 and oversized list limits returned 400. Admin search by an actual item UUID found its order.
* Admin UI created all three product types, accepted Persian digits and adjusted physical stock with a reason/current version. No fixture/admin secret ships to the browser client. For automated admin form coverage, only the test browser context intercepted the adapter module to supply an existing real scoped fixture JWT; production has no test-auth flag. Human admin MFA enrollment was not automated.
* The test lost a successful create response at the browser boundary. Retrying the retained operation key returned the original order. Real payment then produced one access grant, one subscription extension and one shipment; active polling updated both workflow and typed evidence.
* A private expiry-clock fixture plus an actual admin price edit produced BASKET_CHANGED. Previous/new prices were shown and explicit confirmation preceded further action. Unpaid cancellation settled normally.
* The private Bank TIMEOUT_BEFORE assignment produced a visible unknown result with PAYMENT_PENDING stock retained. Customer cancellation waited for the Bank no-charge fence. A separate already-paid, not-yet-started cancellation confirmed a full return without fulfillment.
* For a paid 110-IRR order, the digital 60 line succeeded while the physical 50 line remained deferred. Admin UI recorded a real count discrepancy, navigated from its affected item to the order, and requested the guarded whole-line shortage return. The result retained successful digital access and confirmed exactly 50 returned. Refund records/logs were opened through the UI.
* A test order executed 12 actual transient failures. Private due/age fixtures avoided a real 30-minute wait; the real recovery-cost checkpoint opened review. After repairing the private simulation rule, the admin UI opened one audited cycle. Attempt 13 succeeded once and prior evidence remained. This is not a 30-minute endurance claim.
* A 120-digit price rendered exactly in the admin view; the 60,000-digit formatting case ran separately as a unit check. Mobile amounts/IDs scroll or wrap locally rather than stretching the page.

Fixtures created by the successful runs were deactivated through the API. Three identified fixtures from an interrupted browser run were also deactivated through reasoned/versioned API calls; every order, audit record, stock transition and financial obligation was retained. Earlier unrelated retained catalog records were left alone.

## Visual review

Six full-page captures at 1360×900 and 390×844 are gitignored under `.local/verification/ui/`: catalog, order and admin, each desktop/mobile. They were opened and validated as actual nonblank views. An independent Impeccable reviewer requested two material fixes: mobile item-table fragmentation and machine event names in customer summaries. Both were corrected in one batch, recaptured once and scored **resolved**. The final **ship** disposition covers those two fixes, not a new unlimited audit. PRODUCT.md, DESIGN.md and `.impeccable/design.json` record the shipped scope/tokens.

The optional context/detector launcher could not run: its engine was absent and its external cache directory was not writable. No detector pass is claimed. Verification used the live browser, DOM assertions and independent visual review. No raster comp or imagery was required by the deliberately simple operating brief.

Initial functional failures uncovered the adapter's additional module file, missing browser subject scope on an existing client and native DOM array/null handling. These were repaired; server token checks were never weakened. The earlier review-list regression exposed a test's first-page assumption and was fixed by exercising real cursor pagination.

## Resources and remaining work

All nine steady services were healthy at completion. Caps remain 5,888 MiB / 3.35 cores: static UI adds no running service. One post-check sample in MiB was Gateway 64.31, Commerce 149.5, Billing 108.9, Bank 88.29, Identity 643.4, PostgreSQL 108.3, RabbitMQ 91.88, Redis 7.145, monitor 1.801. Browser verification's 1,536-MiB cap and build tooling are outside that steady envelope.

These are functional/post-check observations, not sustainable RPS or latency measurements. Step 8 remains constrained-host load/failure measurement, longer outages, backup/restore evidence, final API/submission material and deployment tuning. Browser Chromium desktop/mobile is covered; cross-browser/device certification and human admin MFA walkthrough are not claimed. Existing terminal refund declines remain visible debts, not artificially successful test cleanup.
