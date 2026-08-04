const express = require('express');
const router = express.Router();
const Shop = require('../models/Shop');
const MenuItem = require('../models/MenuItem');
const User = require('../models/User');
const Order = require('../models/Order');
const Announcement = require('../models/Announcement');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.use(requireAdmin);

router.get('/shops', asyncHandler(async (req, res) => {
  const shops = await Shop.find().populate('ownerId', 'name email');
  res.json(shops);
}));

const SHOP_FIELDS = ['name', 'description', 'isOpen', 'estimatedPrepTime', 'minOrder', 'ownerEmail', 'categories'];

const buildShopPayload = async (body) => {
  const payload = {};
  for (const field of SHOP_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  if (payload.ownerEmail) {
    payload.ownerEmail = payload.ownerEmail.trim().toLowerCase();
    const owner = await User.findOne({ email: payload.ownerEmail });
    payload.ownerId = owner ? owner._id : null;
  } else if (payload.ownerEmail === '') {
    payload.ownerId = null;
  }
  return payload;
};

router.post('/shops', asyncHandler(async (req, res) => {
  const payload = await buildShopPayload(req.body);
  const shop = await Shop.create(payload);
  res.status(201).json(shop);
}));

router.patch('/shops/:id', asyncHandler(async (req, res) => {
  const payload = await buildShopPayload(req.body);
  const shop = await Shop.findByIdAndUpdate(req.params.id, payload, { new: true }).populate('ownerId', 'name email');
  res.json(shop);
}));

router.delete('/shops/:id', asyncHandler(async (req, res) => {
  await Shop.findByIdAndUpdate(req.params.id, { isPermanentlyClosed: true, isOpen: false });
  res.json({ message: 'Shop softly deleted' });
}));

router.get('/menu/:shopId', asyncHandler(async (req, res) => {
  const items = await MenuItem.find({ shop: req.params.shopId });
  res.json(items);
}));

router.post('/menu', asyncHandler(async (req, res) => {
  const item = await MenuItem.create(req.body);
  res.status(201).json(item);
}));

router.patch('/menu/:id', asyncHandler(async (req, res) => {
  const item = await MenuItem.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(item);
}));

router.delete('/menu/:id', asyncHandler(async (req, res) => {
  await MenuItem.findByIdAndDelete(req.params.id);
  res.json({ message: 'Menu item deleted' });
}));

router.get('/users', asyncHandler(async (req, res) => {
  const users = await User.find();
  res.json(users);
}));

router.patch('/users/:id/role', asyncHandler(async (req, res) => {
  const { role } = req.body;
  const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true });
  res.json(user);
}));

router.get('/orders', asyncHandler(async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 }).populate('shop', 'name').populate('user', 'name email');
  res.json(orders);
}));

router.post('/announcements', asyncHandler(async (req, res) => {
  const announcement = await Announcement.create(req.body);
  res.status(201).json(announcement);
}));

router.get('/analytics', asyncHandler(async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const orders = await Order.find({ createdAt: { $gte: startOfDay } });
  
  const statusCounts = orders.reduce((acc, order) => {
    acc[order.status] = (acc[order.status] || 0) + 1;
    return acc;
  }, {});

  const revenue = orders.filter(o => o.status !== 'cancelled').reduce((acc, order) => acc + order.total, 0);
  
  const itemCounts = {};
  for (const order of orders) {
    if (order.status !== 'cancelled') {
      for (const item of order.items) {
        itemCounts[item.name] = (itemCounts[item.name] || 0) + item.quantity;
      }
    }
  }
  
  const popularItems = Object.entries(itemCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  res.json({ statusCounts, revenue, popularItems });
}));

module.exports = router;
