const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const MenuItem = require('../models/MenuItem');
const Shop = require('../models/Shop');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const { shopId, items, specialInstructions, paymentMethod } = req.body;
  
  const shop = await Shop.findById(shopId);
  if (!shop || !shop.isOpen || shop.isPermanentlyClosed) {
    return res.status(400).json({ message: 'Shop is not available' });
  }

  let subtotal = 0;
  const orderItems = [];

  for (const item of items) {
    const menuItem = await MenuItem.findOne({ _id: item.menuItemId, shop: shopId, isEnabled: true, isAvailable: true });
    if (!menuItem) {
      return res.status(400).json({ message: `Item ${item.menuItemId} is not available` });
    }
    const itemTotal = menuItem.price * item.quantity;
    subtotal += itemTotal;
    orderItems.push({
      menuItem: menuItem._id,
      name: menuItem.name,
      price: menuItem.price,
      quantity: item.quantity
    });
  }

  if (subtotal < (shop.minOrder || 0)) {
    return res.status(400).json({ message: `Minimum order amount is ₹${shop.minOrder}` });
  }

  const serviceFee = 2;
  const total = subtotal + serviceFee;
  
  const orderNumber = 'ORD-' + String(Date.now() % 1000000).padStart(6, '0');

  const order = await Order.create({
    orderNumber,
    user: req.user._id,
    shop: shopId,
    items: orderItems,
    subtotal,
    serviceFee,
    total,
    paymentMethod,
    specialInstructions
  });

  const io = req.app.get('io');
  if (io) {
    io.to(`shop-${shopId}`).emit('newOrder', order);
  }

  res.status(201).json(order);
}));

router.get('/my', requireAuth, asyncHandler(async (req, res) => {
  const orders = await Order.find({ user: req.user._id }).sort({ createdAt: -1 }).populate('shop', 'name');
  res.json(orders);
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user._id }).populate('shop', 'name');
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }
  res.json(order);
}));

module.exports = router;
