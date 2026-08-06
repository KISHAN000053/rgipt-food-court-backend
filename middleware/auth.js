const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Shop = require('../models/Shop');

const requireAuth = async (req, res, next) => {
  try {
    // Prefer cookie, but fall back to Authorization: Bearer header for browsers that
    // block cross-site cookies (Brave, Safari, strict privacy settings).
    let token = req.cookies.token;
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.slice(7);
    }
    if (!token) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }
    
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

const requireAdmin = async (req, res, next) => {
  await requireAuth(req, res, async () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden: Admin access required' });
    }
    next();
  });
};

const requireShopOwner = async (req, res, next) => {
  await requireAuth(req, res, async () => {
    // ownerEmail is always stored lowercased, so the lookup must match that.
    const email = req.user.email.toLowerCase();

    if (req.user.role === 'admin') {
      if (req.params.id) {
        req.shop = await Shop.findById(req.params.id);
      } else {
        req.shop = await Shop.findOne({ ownerEmail: email });
      }
      if (!req.shop) {
        return res.status(404).json({ message: 'No shop found for this account.' });
      }
      return next();
    }

    const shop = await Shop.findOne({ ownerEmail: email });
    if (!shop) {
      return res.status(403).json({ message: 'Forbidden: Shop owner access required' });
    }
    
    req.shop = shop;
    next();
  });
};

module.exports = { requireAuth, requireAdmin, requireShopOwner };
