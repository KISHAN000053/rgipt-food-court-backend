require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const http = require('http');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const User = require('./models/User');
const Shop = require('./models/Shop');
const errorHandler = require('./middleware/errorHandler');
const compression = require('compression');

const app = express();
const server = http.createServer(app);

// Support one or several trusted frontend origins without using wildcard CORS
// with credentials. FRONTEND_URL remains supported for existing deployments.
const allowedOrigins = [...new Set([
  process.env.FRONTEND_URL,
  ...(process.env.FRONTEND_URLS || '').split(','),
].map((value) => (value || '').trim().replace(/\/$/, '')).filter(Boolean))];

const corsOptions = {
  origin(origin, callback) {
    // Requests without an Origin header include same-origin/server-to-server traffic.
    if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ''))) {
      return callback(null, true);
    }
    return callback(new Error('Origin is not allowed by CORS.'));
  },
  credentials: true,
};

const io = new Server(server, { cors: corsOptions });
app.set('io', io);

// Authenticate Socket.IO connections before allowing them to join private rooms.
// The frontend sends the same short-lived JWT used by REST requests. Cookie auth
// remains a fallback for clients that don't send handshake.auth.token.
io.use(async (socket, next) => {
  try {
    const cookieHeader = socket.handshake.headers.cookie || '';
    const cookieToken = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('token='))
      ?.slice('token='.length);
    const token = socket.handshake.auth?.token || cookieToken;
    if (!token || !process.env.JWT_SECRET) {
      return next(new Error('Unauthorized'));
    }

    const decoded = jwt.verify(decodeURIComponent(token), process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return next(new Error('Unauthorized'));

    socket.data.user = {
      id: String(user._id),
      email: String(user.email || '').toLowerCase(),
      role: user.role,
    };
    next();
  } catch (error) {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const user = socket.data.user;

  socket.on('join_shop', async (shopId) => {
    try {
      if (typeof shopId !== 'string' || !mongoose.Types.ObjectId.isValid(shopId)) return;
      if (user.role === 'admin') {
        const shopExists = await Shop.exists({ _id: shopId });
        if (shopExists) socket.join(`shop-${shopId}`);
        return;
      }
      const ownedShop = await Shop.exists({ _id: shopId, ownerEmail: user.email });
      if (ownedShop) socket.join(`shop-${shopId}`);
    } catch (error) {
      console.error('[Socket.IO] Could not authorize shop room join:', error.message);
    }
  });

  socket.on('join_user', (userId) => {
    // A signed-in user may only subscribe to their own private room; admins may
    // subscribe to another user room for explicitly authorized admin workflows.
    if (typeof userId !== 'string') return;
    if (userId === user.id || user.role === 'admin') socket.join(`user-${userId}`);
  });
});

// Middleware
app.use(cors(corsOptions));
app.use(compression());

// Razorpay webhook needs the raw, unparsed body to verify its signature — must be
// registered before express.json() or the signature check will always fail.
app.use('/api/payments/razorpay/webhook', express.raw({ type: '*/*' }));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(passport.initialize());

// Routes
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/shops', require('./routes/shops'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/hostels', require('./routes/hostels'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/push', require('./routes/push'));
app.use('/api/owner', require('./routes/shopOwner'));
app.use('/api/admin', require('./routes/admin'));

// Error handling
app.use(errorHandler);

// Database connection + server start
const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  const required = ['MONGODB_URI', 'JWT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'FRONTEND_URL'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(`Missing required production environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (process.env.JWT_SECRET === 'secret' || process.env.JWT_SECRET.length < 32) {
    console.error('JWT_SECRET must be a unique random secret of at least 32 characters in production.');
    process.exit(1);
  }
}

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/rgipt-food-court')
  .then(() => {
    console.log('Connected to MongoDB');
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      if (!allowedOrigins.length) {
        console.warn('No FRONTEND_URL/FRONTEND_URLS configured; browser cross-origin requests will be rejected.');
      }
    });
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });

// Catch unhandled promise rejections globally
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
