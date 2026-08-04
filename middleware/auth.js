const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Shop = require('../models/Shop');

const requireAuth = async (req, res, next) => {
  try {
    const token = req.cookies.token;
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
    if (req.user.role === 'admin') {
      if (req.params.id) {
        req.shop = await Shop.findById(req.params.id);
      } else {
         req.shop = await Shop.findOne({ ownerEmail: req.user.email });
      }
      return next();
    }
    
    const shop = await Shop.findOne({ ownerEmail: req.user.email });
    if (!shop) {
      return res.status(403).json({ message: 'Forbidden: Shop owner access required' });
    }
    
    req.shop = shop;
    next();
  });
};

module.exports = { requireAuth, requireAdmin, requireShopOwner };
