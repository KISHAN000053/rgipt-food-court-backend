const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const MenuItem = require('../models/MenuItem');
const Shop = require('../models/Shop');
const Settings = require('../models/Settings');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const { placeOrder } = require('../services/orderService');

// Normal checkout. Splitting per shop and fee handling live in the shared order
// service so party checkout can't drift from this logic.
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const { items, specialInstructions, paymentMethod, orderType } = req.body;

  const result = await placeOrder({
    user: req.user,
    items,
    orderType,
    paymentMethod,
    specialInstructions,
    io: req.app.get('io'),
  });

  if (!result.ok) {
    return res.status(result.status).json({ message: result.message });
  }

  res.status(201).json({ groupId: result.groupId, orders: result.orders });
}));

router.get('/my', requireAuth, asyncHandler(async (req, res) => {
  const orders = await Order.find({ user: req.user._id }).sort({ createdAt: -1 }).populate('shop', 'name');
  res.json(orders);
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id })
    .populate('shop', 'name')
    .populate('user', 'hostel roomNumber phone');
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }
  // Include sibling orders from the same checkout (other shops), if any.
  let siblings = [];
  if (order.groupId) {
    siblings = await Order.find({ groupId: order.groupId, user: req.user._id, _id: { $ne: order._id } }).populate('shop', 'name');
  }
  res.json({ ...order.toObject(), siblings });
}));

module.exports = router;
