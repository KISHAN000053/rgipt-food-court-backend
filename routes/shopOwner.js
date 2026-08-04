const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const MenuItem = require('../models/MenuItem');
const { requireShopOwner } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.use(requireShopOwner);

router.get('/orders', asyncHandler(async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  
  const orders = await Order.find({
    shop: req.shop._id,
    createdAt: { $gte: startOfDay }
  }).sort({ createdAt: -1 }).populate('user', 'name phone roomNumber hostel');
  
  res.json(orders);
}));

router.get('/orders/pending', asyncHandler(async (req, res) => {
  const orders = await Order.find({
    shop: req.shop._id,
    status: { $in: ['pending', 'accepted', 'preparing'] }
  }).sort({ createdAt: 1 }).populate('user', 'name phone roomNumber hostel');
  
  res.json(orders);
}));

// Simple, shop-friendly flow: pending -> accepted -> [preparing] -> delivery_initiated.
// Preparing is optional — a shop can go straight from accepted to delivery_initiated.
// Cancelled is allowed from any non-terminal state.
const ALLOWED_TRANSITIONS = {
  pending: ['accepted', 'cancelled'],
  accepted: ['preparing', 'delivery_initiated', 'cancelled'],
  preparing: ['delivery_initiated', 'cancelled'],
  delivery_initiated: [],
  cancelled: [],
};

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

const MENU_FIELDS = ['name', 'price', 'category', 'description', 'isVeg', 'isAvailable', 'isEnabled'];

const buildMenuPayload = (body) => {
  const payload = {};
  for (const field of MENU_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  return payload;
};

router.post('/menu', asyncHandler(async (req, res) => {
  const payload = buildMenuPayload(req.body);
  if (!payload.name || payload.price === undefined || !payload.category) {
    return res.status(400).json({ message: 'Name, price and category are required' });
  }
  if (Number(payload.price) < 0) {
    return res.status(400).json({ message: 'Price cannot be negative' });
  }
  const item = await MenuItem.create({ ...payload, shop: req.shop._id });
  res.status(201).json(item);
}));

router.delete('/menu/:itemId', asyncHandler(async (req, res) => {
  const item = await MenuItem.findOneAndDelete({ _id: req.params.itemId, shop: req.shop._id });
  if (!item) {
    return res.status(404).json({ message: 'Menu item not found' });
  }
  res.json({ message: 'Menu item deleted' });
}));

router.patch('/menu/:itemId', asyncHandler(async (req, res) => {
  const payload = buildMenuPayload(req.body);
  if (payload.price !== undefined && Number(payload.price) < 0) {
    return res.status(400).json({ message: 'Price cannot be negative' });
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
    status: { $ne: 'cancelled' }
  });
  
  const revenue = orders.reduce((acc, order) => acc + order.total, 0);
  
  res.json({
    orderCount: orders.length,
    revenue
  });
}));

module.exports = router;
