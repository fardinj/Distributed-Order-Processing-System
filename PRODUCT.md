# TOPS

## Platform

Web, in Persian with right-to-left layout; desktop and mobile browsers.

## Purpose and users

A hiring-task order-processing system. Customers place physical/digital/subscription orders and observe payment, fulfillment and refunds. Admins manage catalog/stock and inspect guarded review actions. A reviewer should demonstrate flows without composing API requests. These facts and the deliberately small UI scope come from the user's Q18 selection and docs/UI_SCOPE.md.

## Constraints

Exact whole IRR strings, including amounts beyond JavaScript Number. Server-authoritative identity, ownership, prices, stock, outcomes and eligibility. Cancellation closes at first fulfillment start. Unknown money never means confirmed failure/refund. No arbitrary customer impersonation, forced state or public fault controls. Use existing OIDC with public client/S256 PKCE and in-memory tokens; admins retain provider MFA. Preserve accepted work during pressure and display rejection honestly.

## Stack

Static browser ES modules/HTML/CSS served by the existing Nest gateway; no additional running frontend service. This is the routine implementation choice delegated by UI_SCOPE.md within the 8-GiB/four-core budget. Pinned local Keycloak browser adapter and self-hosted Vazirmatn font; backend APIs remain the authorization boundary.

## Visual scope

The selected brief calls for a simple neutral interface, clear states, forms and lists. This is an operation tool, not a marketing surface. No image/animation/chart program is required. Styling choices are implementation defaults; no new business-policy approval is implied. DESIGN.md records the shipped tokens.
