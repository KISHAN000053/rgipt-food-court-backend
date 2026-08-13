const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

// There is no POST '/' here anymore — an order is only ever created once payment is
// confirmed, in routes/payments.js (finalizeCheckout). This route only ever reads
// orders that already exist and were genuinely paid for.

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
