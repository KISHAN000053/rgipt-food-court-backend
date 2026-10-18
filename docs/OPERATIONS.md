# Backend setup and operations

## 1. Local development

Requirements: Node.js 20 or another currently supported LTS release, npm, and MongoDB.

```bash
npm install
cp .env.example .env
npm run dev
```

Fill in the values in `.env`. Google sign-in requires OAuth credentials and a callback URI registered in Google Cloud. Local callback: `http://localhost:5000/api/auth/google/callback`.

Useful commands:

```bash
npm start       # production-style process
npm test        # built-in Node test runner
npm run seed:hostels
npm run seed:shop5-addons
```

The two seed scripts are not interchangeable generic fixtures:
- `seed:hostels` contains RGIPT hostel examples; edit and review it before using another campus database.
- `seed:shop5-addons` is a legacy migration for a specific shop. Do not run it on a different campus without adapting it.

## 2. Required configuration

Set values in the hosting provider's secret/environment dashboard; never commit real values.

- `MONGODB_URI`: production database connection string with a dedicated database user and least-necessary permissions.
- `JWT_SECRET`: unique random secret, at least 32 characters. Use a different value for development and production.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`: OAuth application values and exact callback.
- `FRONTEND_URL`: primary frontend origin.
- `FRONTEND_URLS`: optional comma-separated additional trusted origins; useful when a deployment needs a second official frontend origin.
- `ALLOWED_EMAIL_DOMAINS`: comma-separated domains without `@`. Defaults to `rgipt.ac.in` for backward compatibility.
- `ADMIN_EMAILS`: comma-separated admin email addresses.
- `CAMPUS_NAME`: brand used in push notification titles.
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`: payment API credentials.
- `RAZORPAY_WEBHOOK_SECRET`: webhook-specific secret configured in Razorpay.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`: web push configuration.
- `NODE_ENV=production`: enables production security behavior.

Do not put private values in frontend `VITE_*` variables. They are embedded into the public browser bundle.

## 3. Render or similar deployment

1. Create a Node web service from this repository.
2. Install/build command: `npm install`.
3. Start command: `npm start`.
4. Add the production environment variables above.
5. Configure the MongoDB provider to allow connections from the hosting environment.
6. Set the Google OAuth callback to `https://YOUR_BACKEND_HOST/api/auth/google/callback`.
7. Set `FRONTEND_URL` to the exact deployed frontend origin; add other trusted origins to `FRONTEND_URLS` if needed.
8. Configure Razorpay webhooks to `https://YOUR_BACKEND_HOST/api/payments/razorpay/webhook` and subscribe to the captured-payment and refund events used by the code.
9. Deploy and confirm `GET /api/health` responds.
10. Test sign-in, profile/onboarding, menu availability, payment success/failure, webhook delivery, refund status, push subscriptions, and live order updates with test accounts and test-mode payments before accepting real money.

## 4. Reuse for another campus

This repository currently represents a **single-campus deployment**. For a new campus:
1. Set the campus frontend variables and backend `CAMPUS_NAME`.
2. Set `ALLOWED_EMAIL_DOMAINS` and `ADMIN_EMAILS`.
3. Review the campus hostel model and seed script; remove or replace campus-specific hostel values.
4. Review support email, terms, privacy, food-safety and payment policies, and the applicable jurisdiction.
5. Configure independent Google OAuth and Razorpay applications where appropriate.
6. Audit every query and authorization rule before sharing one deployment between campuses. Multiple email domains are not tenant isolation; multi-tenant operation requires tenant IDs and isolation enforced throughout every relevant model/query.
7. Test with distinct student, shop-owner, and administrator accounts.

## 5. Security operations

- Rotate exposed credentials immediately and update host environment variables.
- Keep database network access restricted; never commit `.env`.
- Use unique secrets per environment and HTTPS in production.
- Review the private-room authorization for Socket.IO before adding new event types.
- Keep webhook signature verification enabled and never trust a frontend payment-success callback alone.
- Back up the database before migrations or seed scripts.
- Review GitHub Actions and Dependabot alerts regularly.
- If you suspect a secret was committed, rotate it first; deleting it from the latest file does not erase Git history.
- The health endpoint confirms only that the process is responding. Add external monitoring for database, payment, OAuth, and webhook health.

## 6. Known boundaries

The automated tests cover pure cart-validation and order-state rules. They do not replace integration tests against MongoDB, Google OAuth, Razorpay, browser push, or a deployed frontend/backend pair. Do not treat a passing build as a production security certification.
