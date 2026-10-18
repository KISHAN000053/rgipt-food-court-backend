# Backend API reference

Base URL examples:
- Local: `http://localhost:5000`
- Production: your deployed backend origin, without a trailing slash

All JSON endpoints use `Content-Type: application/json` unless noted. Protected endpoints accept the HTTP-only `token` cookie or an `Authorization: Bearer <JWT>` header. Never treat frontend route guards as authorization; the API must enforce roles and ownership.

## Health and public data

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/health` | Public | Process/HTTP health check; does not prove all integrations are healthy |
| GET | `/api/shops` | Public | List shops |
| GET | `/api/shops/:id` | Public | Read shop details |
| GET | `/api/menu/shops/:id/menu` | Public | Read a shop menu |
| GET | `/api/menu/shops/:id/addons` | Public | Read shop add-ons |
| GET | `/api/hostels` | Public | List configured hostels |
| GET | `/api/settings/public` | Public | Public checkout fee settings |
| GET | `/api/push/vapid-public-key` | Public | Public VAPID key for browser push |

## Authentication and user profile

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/auth/google` | Public | Begin Google OAuth |
| GET | `/api/auth/google/callback` | OAuth callback | Complete sign-in and redirect to the frontend |
| GET | `/api/auth/me` | Signed in | Return the current user |
| POST | `/api/auth/logout` | Public/signed in | Clear the auth cookie |
| PATCH | `/api/users/profile` | Signed in | Update the current user's profile |
| PATCH | `/api/users/accept-terms` | Signed in | Record terms acceptance |

Allowed campus email domains are configured with `ALLOWED_EMAIL_DOMAINS`. `ADMIN_EMAILS` grants admin role on sign-in; shop-owner access is tied to configured shop ownership. Review `routes/auth.js` before changing these rules.

## Orders and payments

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/orders/my` | Signed in | Current user's orders |
| GET | `/api/orders/:id` | Order owner | Read one order and its checkout siblings |
| POST | `/api/payments/razorpay/create-order` | Signed in | Validate/reprice cart and create a payment attempt |
| POST | `/api/payments/razorpay/verify` | Checkout owner | Verify payment response and finalize checkout |
| POST | `/api/payments/razorpay/webhook` | Razorpay signature | Process captured-payment/refund webhook events |

The backend recalculates prices from database menu items. Do not send a client-calculated total as authoritative. Configure the webhook URL in Razorpay and set `RAZORPAY_WEBHOOK_SECRET` to the webhook-specific secret, not the API key secret.

## Shop-owner endpoints

All paths below are prefixed with `/api/owner` and require shop-owner access (or an admin acting on a shop where supported).

| Method | Path | Purpose |
|---|---|---|
| GET | `/shop` | Current shop information |
| PATCH | `/shop/status` | Change online/offline state |
| GET | `/orders` | Today's confirmed orders |
| GET | `/orders/pending` | Active confirmed orders |
| PATCH | `/orders/:id/status` | Update an order's status |
| GET | `/menu` | Read shop menu |
| POST | `/menu` | Add a menu item |
| PATCH | `/menu/:itemId` | Update a menu item |
| DELETE | `/menu/:itemId` | Remove a menu item |
| GET | `/stats` | Shop statistics |
| GET | `/report` | Shop report |
| GET | `/report/annexure` | Detailed report export |

## Administrator endpoints

All paths below are prefixed with `/api/admin` and require the admin role.

| Method | Path | Purpose |
|---|---|---|
| GET | `/payouts` | Payout reconciliation and exceptions |
| GET/PATCH | `/settings` | Read/update platform settings |
| GET/POST | `/shops` | List/create shops |
| PATCH/DELETE | `/shops/:id` | Update/deactivate a shop |
| DELETE | `/shops/:id/permanent` | Permanently deactivate a shop |
| GET | `/menu/:shopId` | Read a shop menu |
| POST | `/menu` | Create menu item |
| PATCH/DELETE | `/menu/:id` | Update/delete menu item |
| GET | `/users` | List users |
| PATCH | `/users/:id/role` | Change user role |
| DELETE | `/users/:id` | Delete user |
| GET/POST | `/hostels` | List/create hostels |
| PATCH/DELETE | `/hostels/:id` | Update/delete hostel |
| GET | `/orders` | List orders |
| PATCH | `/orders/:id/status` | Update order status |
| POST | `/announcements` | Create announcement |
| GET | `/analytics` | Platform analytics |

Confirm exact request body shapes and response fields in the route implementation before integrating another client. This table is an endpoint map, not a versioned OpenAPI contract.

## Push notifications

- `POST /api/push/subscribe` — signed-in user saves/updates their subscription.
- `POST /api/push/unsubscribe` — signed-in user removes a subscription.
- Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` on the backend.

## Socket.IO events

The frontend connects to Socket.IO and sends its auth JWT in the handshake. The backend authenticates the connection and authorizes private room joins:
- `join_user` — only the same user or an admin can join a `user-<id>` room.
- `join_shop` — only that shop's owner or an admin can join a `shop-<id>` room.
- `orderStatusChanged` — emitted to the order owner's private room.
- `newOrder` — emitted to the shop's private room.
- `shopStatusChanged` — public status refresh event.

## Error handling

Production API responses intentionally avoid returning stack traces or internal exception objects. Use server logs and request IDs/timestamps to investigate errors. Do not expose raw provider errors or secrets to clients.
