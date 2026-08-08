const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const MenuItem = require('../models/MenuItem');
const { requireShopOwner } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { CONFIRMED_PAYMENT_FILTER } = require('../utils/orderFilters');
const { refundOrderIfNeeded, ALLOWED_TRANSITIONS } = require('../services/orderService');

router.use(requireShopOwner);

// The shop owner's own shop info — used to show name + open/closed state.
router.get('/shop', asyncHandler(async (req, res) => {
  res.json({
    _id: req.shop._id,
    name: req.shop.name,
    isOpen: req.shop.isOpen,
    isPermanentlyClosed: req.shop.isPermanentlyClosed,
    menuEditingEnabled: req.shop.menuEditingEnabled,
  });
}));

// Owner toggles their own shop online/offline whenever they want.
router.patch('/shop/status', asyncHandler(async (req, res) => {
  if (req.shop.isPermanentlyClosed) {
    return res.status(400).json({ message: 'This shop has been deactivated by an admin and cannot be reopened here.' });
  }
  const { isOpen } = req.body;
  req.shop.isOpen = !!isOpen;
  await req.shop.save();

  // Same live-update mechanism admin uses — students see it instantly.
  const io = req.app.get('io');
  if (io) io.emit('shopStatusChanged', { shopId: String(req.shop._id), isOpen: req.shop.isOpen, name: req.shop.name });

  res.json({ _id: req.shop._id, name: req.shop.name, isOpen: req.shop.isOpen });
}));

router.get('/orders', asyncHandler(async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  
  const orders = await Order.find({
    shop: req.shop._id,
    createdAt: { $gte: startOfDay },
    ...CONFIRMED_PAYMENT_FILTER,
  }).sort({ createdAt: -1 }).populate('user', 'name phone roomNumber hostel');
  
  res.json(orders);
}));

router.get('/orders/pending', asyncHandler(async (req, res) => {
  const orders = await Order.find({
    shop: req.shop._id,
    status: { $in: ['pending', 'accepted', 'preparing'] },
    ...CONFIRMED_PAYMENT_FILTER,
  }).sort({ createdAt: 1 }).populate('user', 'name phone roomNumber hostel');
  
  res.json(orders);
}));

router.patch('/orders/:id/status', asyncHandler(async (req, res) => {
  const { status } = req.body;
  const existing = await Order.findOne({ _id: req.params.id, shop: req.shop._id });
  if (!existing) {
    return res.status(404).json({ message: 'Order not found' });
  }

  const allowedNext = ALLOWED_TRANSITIONS[existing.status] || [];
  if (!allowedNext.includes(status)) {
    return res.status(400).json({ message: `Cannot move order from "${existing.status}" to "${status}"` });
  }

  existing.status = status;
  await existing.save();

  // Cancelling a paid order automatically refunds the food price (fees are kept).
  // This never blocks the cancellation itself — a refund failure is only marked
  // on the order for later follow-up.
  if (status === 'cancelled') {
    await refundOrderIfNeeded(existing);
  }
  
  const io = req.app.get('io');
  if (io) {
    io.to(`user-${existing.user}`).emit('orderStatusChanged', existing);
  }
  
  res.json(existing);
}));

router.get('/menu', asyncHandler(async (req, res) => {
  const items = await MenuItem.find({ shop: req.shop._id });
  res.json(items);
}));

const MENU_FIELDS = ['name', 'price', 'hasVariants', 'variants', 'category', 'description', 'isVeg', 'isAvailable', 'isEnabled', 'isAddon'];

// Shop owners may only change prices between 4:00 and 14:00 (IST). Everything else
// about an item (availability, name, category) can be edited any time.
// Admins are exempt so you can always correct a price.
const PRICE_WINDOW_START = 4;   // 4 AM
const PRICE_WINDOW_END = 14;    // 2 PM

const isWithinPriceWindow = () => {
  // Server runs in UTC on Render; convert to IST (UTC+5:30) for the campus-local window.
  const nowUtcMs = Date.now();
  const istMs = nowUtcMs + (5 * 60 + 30) * 60 * 1000;
  const istHour = new Date(istMs).getUTCHours();
  return istHour >= PRICE_WINDOW_START && istHour < PRICE_WINDOW_END;
};

const priceWindowMessage = 'Prices can only be changed between 4:00 AM and 2:00 PM. You can still update availability and other details.';

function validateMenuPricing(payload) {
  if (payload.hasVariants) {
    if (!Array.isArray(payload.variants) || payload.variants.length < 2) {
      return 'Add at least 2 price options, or switch to a single price.';
    }
    for (const v of payload.variants) {
      if (v.price === undefined || v.price === null || Number(v.price) < 0) {
        return 'Every price option needs a valid price.';
      }
    }
  } else if (payload.price !== undefined && Number(payload.price) < 0) {
    return 'Price cannot be negative';
  }
  return null;
}

// Compares an existing item's pricing against an incoming payload — used to decide
// whether the 4am-2pm window applies. Works whether the item is single-price or
// switching between single/variant, or editing variant prices.
function hasPriceChanged(existing, payload) {
  const willHaveVariants = payload.hasVariants !== undefined ? payload.hasVariants : existing.hasVariants;
  if (willHaveVariants) {
    const newVariants = payload.variants !== undefined ? payload.variants : existing.variants;
    const oldVariants = existing.variants || [];
    if (newVariants.length !== oldVariants.length) return true;
    return newVariants.some((v, idx) => Number(v.price) !== Number(oldVariants[idx]?.price));
  }
  if (payload.price === undefined) return false;
  return Number(existing.price) !== Number(payload.price);
}

const buildMenuPayload = (body) => {
  const payload = {};
  for (const field of MENU_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  if (payload.isAddon) {
    payload.category = 'Add-ons';
    payload.hasVariants = false;
    payload.variants = [];
  }
  return payload;
};

router.post('/menu', asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin' && !req.shop.menuEditingEnabled) {
    return res.status(403).json({ message: 'Menu editing has been restricted by admin for your shop. Contact admin to add items.' });
  }
  const payload = buildMenuPayload(req.body);
  if (!payload.name) {
    return res.status(400).json({ message: 'Name is required' });
  }
  if (!payload.isAddon && !payload.category) {
    return res.status(400).json({ message: 'Category is required' });
  }
  if (!payload.hasVariants && payload.price === undefined) {
    return res.status(400).json({ message: 'Price is required' });
  }
  const pricingError = validateMenuPricing(payload);
  if (pricingError) return res.status(400).json({ message: pricingError });
  if (req.user.role !== 'admin' && !isWithinPriceWindow()) {
    return res.status(403).json({ message: 'New items can only be added between 4:00 AM and 2:00 PM.' });
  }
  if (payload.hasVariants) payload.price = 0;
  const item = await MenuItem.create({ ...payload, shop: req.shop._id });
  res.status(201).json(item);
}));

router.delete('/menu/:itemId', asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin' && !req.shop.menuEditingEnabled) {
    return res.status(403).json({ message: 'Menu editing has been restricted by admin for your shop. Contact admin to remove items.' });
  }
  const item = await MenuItem.findOneAndDelete({ _id: req.params.itemId, shop: req.shop._id });
  if (!item) {
    return res.status(404).json({ message: 'Menu item not found' });
  }
  res.json({ message: 'Menu item deleted' });
}));

router.patch('/menu/:itemId', asyncHandler(async (req, res) => {
  const payload = buildMenuPayload(req.body);

  if (req.user.role !== 'admin' && !req.shop.menuEditingEnabled) {
    // Even when restricted, a shop owner can still mark something in/out of stock —
    // that's day-to-day operations, not "editing the menu". Anything beyond that
    // (name, category, price, variants, description) is blocked.
    const onlyTouchesAvailability = Object.keys(payload).every(k => k === 'isAvailable');
    if (!onlyTouchesAvailability) {
      return res.status(403).json({ message: 'Menu editing has been restricted by admin for your shop. You can still mark items in or out of stock. Contact admin for other changes.' });
    }
  }

  const pricingError = validateMenuPricing(payload);
  if (pricingError) return res.status(400).json({ message: pricingError });

  const existing = await MenuItem.findOne({ _id: req.params.itemId, shop: req.shop._id });
  if (!existing) {
    return res.status(404).json({ message: 'Menu item not found' });
  }

  if (req.user.role !== 'admin' && hasPriceChanged(existing, payload) && !isWithinPriceWindow()) {
    return res.status(403).json({ message: priceWindowMessage });
  }

  const item = await MenuItem.findOneAndUpdate(
    { _id: req.params.itemId, shop: req.shop._id },
    payload,
    { new: true }
  );
  
  if (!item) {
    return res.status(404).json({ message: 'Menu item not found' });
  }
  
  res.json(item);
}));

router.get('/stats', asyncHandler(async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  
  const orders = await Order.find({
    shop: req.shop._id,
    createdAt: { $gte: startOfDay },
    status: { $ne: 'cancelled' },
    ...CONFIRMED_PAYMENT_FILTER,
  });
  
  const revenue = orders.reduce((acc, order) => acc + order.total, 0);
  
  res.json({
    orderCount: orders.length,
    revenue
  });
}));

// Order report for a date range. "earnings" = the shop's own subtotal (their prices),
// which is what they actually get paid — platform fees are excluded.
router.get('/report', asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const match = { shop: req.shop._id, status: { $ne: 'cancelled' }, ...CONFIRMED_PAYMENT_FILTER };

  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      match.createdAt.$lte = end;
    }
  }

  const orders = await Order.find(match).sort({ createdAt: -1 }).populate('user', 'name');

  const rows = orders.map(o => ({
    orderId: o._id.toString().slice(-6).toUpperCase(),
    date: o.createdAt,
    customer: o.user?.name || '',
    type: o.orderType === 'takeaway' ? 'Takeaway' : 'Hostel',
    items: o.items.map(i => `${i.quantity}x ${i.name}`).join('; '),
    earnings: Math.round(o.subtotal * 100) / 100,
  }));

  const totalEarnings = Math.round(rows.reduce((sum, r) => sum + r.earnings, 0) * 100) / 100;

  res.json({ rows, totalEarnings, orderCount: rows.length });
}));

module.exports = router;
