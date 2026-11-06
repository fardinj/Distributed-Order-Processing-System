# Simple Persian customer and admin UI

Status: Q18 scope is implemented in step 7. This remains the selected scope brief; [UI_GUIDE.md](UI_GUIDE.md) describes operation and [UI_VERIFICATION.md](UI_VERIFICATION.md) records executed evidence. Root PRODUCT.md and DESIGN.md document product constraints and shipped styling. No new business policy was inferred from visual choices.

## Purpose and audience

Operate mode: customers and admins need to run and observe the backend flows, including stock timers, payment uncertainty, refund progress and recovery. Success means a reviewer can demonstrate a flow without manually composing every API request. Keep the UI small; no marketing site, animations, charts, custom identity platform or elaborate design system is required.

## Customer flow

1. Sign in through the selected OIDC provider; show authenticated customer identity without permitting arbitrary customer-ID entry.
2. Browse the seeded/admin-managed catalog; add physical quantities or one digital/subscription unit.
3. Show final checkout with five-minute server expiry, whole-rial totals and basket revision. If stock/price changes, show old versus revised quantities/total and require confirmation.
4. Enter the simulated payment gateway. Replace the checkout countdown with a clear payment-pending state; stock stays protected until a definitive result. Do not show “stock released” merely because the original five minutes passed.
5. Order detail shows each item, shipment record, payment/reconciliation, pending/confirmed refund amounts and financial summary. Offer cancel/retry only when eligible, while relying on API enforcement for the actual decision.
6. Show refund history and updated progress after replay/refresh. Pending or unknown money is not displayed as returned.

## Admin flow

Sign in as an admin and expose product create/edit/deactivate, stock adjustment with reason/version, discrepancies, searchable order/history/refund views and manual-review actions. Show a confirmation/summary for mutations that affect stock or retry work. Do not expose unrestricted DB editing, forced status writes or customer role escalation as shortcuts.

## Persian and layout constraints

- Persian copy and document lang=fa/dir=rtl. Use simple responsive forms, lists and status tables; a neutral layout is a proposed default, not a visual-system commitment.
- Display whole IRR with a clear ریال label, never an implicit toman conversion. Group arbitrarily large decimal strings without converting through JavaScript Number; keep exact copyable values. Input normalization may convert Persian/Arabic digits to canonical ASCII strings before API submission.
- Keep IDs, timestamps and machine references readable in isolated left-to-right spans where appropriate. Long money/IDs wrap or scroll locally without breaking the page.
- Use explicit text for states, not color alone. Loading, empty, expired, pending, failed, unknown, review, unauthorized and overloaded states are visible. Standard labels/keyboard focus and framework-safe text rendering are enough for this scoped UI.
- Poll only visible active views, pause hidden tabs and back off on 429/503. Provide a retry action and explain capacity rejection without claiming a rejected order exists.

## Security scope

The user's direction is to secure APIs and keep client-side work simple. UI visibility and validation are convenience only; all ownership, admin permissions, amount calculation and workflow eligibility are checked by APIs. Calling the API directly must not bypass these rules.

Use the maintained OIDC/browser integration and normal framework escaping. Do not embed service/admin secrets, add trusted-customer impersonation, disable token validation or accept payment success from a URL parameter. No separate frontend hardening program is added; transport/session handling remains part of the API/identity integration described in SECURITY.md.

## Delivery and verification

Prefer a static client served by the gateway to avoid another always-running SSR service on the 8 GB host. Exact client framework/provider theme is a routine implementation choice. This brief records scope; UI implementation is roadmap step 7.

During implementation, walk through success, basket change, delayed bank result, paid cancellation, partial refund, admin correction and manual review. Inspect desktop/mobile RTL layout, very large money strings and capacity errors. Keep raw API tests as the security/correctness evidence; screenshots alone cannot prove them.
