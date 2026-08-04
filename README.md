# RGIPT Food Court — Backend

Express.js REST API + Socket.io for the RGIPT campus food ordering platform.

## Tech Stack
- Node.js + Express.js
- MongoDB Atlas + Mongoose
- Google OAuth 2.0 (passport-google-oauth20)
- JWT authentication (httpOnly cookies)
- Socket.io (real-time order tracking)

## Setup

```bash
cp .env.example .env
# Fill in all values in .env
npm install
npm run seed    # Populate MongoDB with shops + menu items
npm run dev     # Development server on port 5000
npm start       # Production
```

## Environment Variables

See `.env.example` for all required variables.

## API Routes

| Method | Route | Description |
|---|---|---|
| GET | `/api/auth/google` | Initiate Google login |
| GET | `/api/auth/me` | Current user |
| POST | `/api/auth/logout` | Logout |
| PATCH | `/api/users/profile` | Update hostel/room/phone |
| GET | `/api/shops` | List open shops |
| GET | `/api/shops/:id/menu` | Shop menu |
| GET | `/api/menu/search?q=` | Cross-shop search |
| POST | `/api/orders` | Place order |
| GET | `/api/orders/my` | My orders |
| GET | `/api/owner/orders` | Shop owner orders |
| PATCH | `/api/owner/orders/:id/status` | Update order status |

## Deployment (Render)

1. Connect this repo to Render
2. Build command: `npm install`
3. Start command: `node server.js`
4. Add all environment variables in Render dashboard
