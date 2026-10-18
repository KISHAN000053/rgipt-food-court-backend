# Changelog

## 2026-10-18

- Made allowed campus email domains configurable with `ALLOWED_EMAIL_DOMAINS`, preserving the RGIPT default for existing deployments.
- Restricted CORS to configured trusted frontend origins and authenticated Socket.IO connections; private user/shop room joins now require authorization.
- Added basic browser security headers, production configuration checks, and safer production error responses.
- Added cart-line, quantity, order-type, and special-instructions validation before payment checkout.
- Enforced checkout ownership before payment verification and changed payment/webhook signature comparison to constant-time comparison.
- Made push delivery optional when VAPID keys are absent and made notification branding configurable with `CAMPUS_NAME`.
- Added Node built-in unit tests for cart validation, variant pricing, order state transitions, and pickup PIN checks.
- Added API and operations guides, Dependabot configuration, contributor guidance, and a security policy.
- Added an MIT license for commercial reuse, subject to its terms and any third-party library/provider/asset terms.

## Known boundaries

This remains a single-campus deployment starter. Legacy RGIPT seed scripts still need review before reuse elsewhere. The automated tests do not cover live MongoDB, Google OAuth, Razorpay, push, or browser-to-backend integration.
