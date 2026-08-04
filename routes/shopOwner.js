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

router.patch('/orders/:id/status', asyncHandler(async (req, res) => {
  const { status } = req.body;
  const order = await Order.findOneAndUpdate(
    { _id: req.params.id, shop: req.shop._id },
    { status },
    { new: true }
  );
  
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }
  
  const io = req.app.get('io');
  if (io) {
    io.to(`user-${order.user}`).emit('orderStatusChanged', order);
  }
  
  res.json(order);
}));

router.get('/menu', asyncHandler(async (req, res) => {
  const items = await MenuItem.find({ shop: req.shop._id });
  res.json(items);
}));

router.patch('/menu/:itemId', asyncHandler(async (req, res) => {
  const { isAvailable, isEnabled, price } = req.body;
  const item = await MenuItem.findOneAndUpdate(
    { _id: req.params.itemId, shop: req.shop._id },
    { isAvailable, isEnabled, price },
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
