const express = require('express');
const router = express.Router();
const Shop = require('../models/Shop');
const MenuItem = require('../models/MenuItem');
const User = require('../models/User');
const Order = require('../models/Order');
const Announcement = require('../models/Announcement');
const Settings = require('../models/Settings');
const Hostel = require('../models/Hostel');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.use(requireAdmin);

router.get('/payouts', asyncHandler(async (req, res) => {
  // Owed to each shop = their order subtotals (real prices they set). Platform revenue
  // is the separate processing fee (2%) + service fee, not a price difference.
  const payouts = await Order.aggregate([
    { $match: { status: { $ne: 'cancelled' } } },
    {
      $group: {
        _id: '$shop',
        amountOwed: { $sum: '$subtotal' },
        orderIds: { $addToSet: '$_id' },
      }
    },
    { $lookup: { from: 'shops', localField: '_id', foreignField: '_id', as: 'shop' } },
    { $unwind: '$shop' },
    {
      $project: {
        _id: 0,
        shopId: '$_id',
        shopName: '$shop.name',
        amountOwed: { $round: ['$amountOwed', 2] },
        orderCount: { $size: '$orderIds' },
      }
    },
    { $sort: { shopName: 1 } }
  ]);

  const feeAgg = await Order.aggregate([
    { $match: { status: { $ne: 'cancelled' } } },
    { $group: {
      _id: null,
      totalServiceFees: { $sum: '$serviceFee' },
      totalProcessingFees: { $sum: '$processingFee' },
    } }
  ]);
  const totalServiceFees = Math.round((feeAgg[0]?.totalServiceFees || 0) * 100) / 100;
  const totalMarkupRevenue = Math.round((feeAgg[0]?.totalProcessingFees || 0) * 100) / 100;

  res.json({
    payouts,
    summary: {
      totalOwedToShops: Math.round(payouts.reduce((sum, p) => sum + p.amountOwed, 0) * 100) / 100,
      totalPlatformRevenue: Math.round((totalMarkupRevenue + totalServiceFees) * 100) / 100,
      totalMarkupRevenue,
      totalServiceFees,
    }
  });
}));

router.get('/settings', asyncHandler(async (req, res) => {
  const settings = await Settings.getGlobal();
  res.json(settings);
}));

router.patch('/settings', asyncHandler(async (req, res) => {
  const { razorpaySurchargePercent, serviceFee } = req.body;
  const update = {};
  if (razorpaySurchargePercent !== undefined) {
    const val = Number(razorpaySurchargePercent);
    if (isNaN(val) || val < 0) return res.status(400).json({ message: 'Invalid surcharge percent' });
    update.razorpaySurchargePercent = val;
  }
  if (serviceFee !== undefined) {
    const val = Number(serviceFee);
    if (isNaN(val) || val < 0) return res.status(400).json({ message: 'Invalid service fee' });
    update.serviceFee = val;
  }
  const settings = await Settings.findOneAndUpdate({ key: 'global' }, update, { new: true, upsert: true });
  res.json(settings);
}));

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

const ADMIN_MENU_FIELDS = ['name', 'price', 'category', 'description', 'isVeg', 'isAvailable', 'isEnabled', 'shop'];
const buildAdminMenuPayload = (body) => {
  const payload = {};
  for (const field of ADMIN_MENU_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  return payload;
};

router.post('/menu', asyncHandler(async (req, res) => {
  const payload = buildAdminMenuPayload(req.body);
  if (!payload.name || payload.price === undefined || !payload.category || !payload.shop) {
    return res.status(400).json({ message: 'Name, price, category and shop are required' });
  }
  if (Number(payload.price) < 0) {
    return res.status(400).json({ message: 'Price cannot be negative' });
  }
  const item = await MenuItem.create(payload);
  res.status(201).json(item);
}));

router.patch('/menu/:id', asyncHandler(async (req, res) => {
  const payload = buildAdminMenuPayload(req.body);
  if (payload.price !== undefined && Number(payload.price) < 0) {
    return res.status(400).json({ message: 'Price cannot be negative' });
  }
  const item = await MenuItem.findByIdAndUpdate(req.params.id, payload, { new: true });
  if (!item) return res.status(404).json({ message: 'Menu item not found' });
  res.json(item);
}));

router.delete('/menu/:id', asyncHandler(async (req, res) => {
  const item = await MenuItem.findByIdAndDelete(req.params.id);
  if (!item) return res.status(404).json({ message: 'Menu item not found' });
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

router.delete('/users/:id', asyncHandler(async (req, res) => {
  // Guard: an admin can't delete their own account, and can't delete another admin.
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ message: 'User not found' });
  if (String(target._id) === String(req.user._id)) {
    return res.status(400).json({ message: 'You cannot delete your own account' });
  }
  if (target.role === 'admin') {
    return res.status(400).json({ message: 'Cannot delete an admin account' });
  }
  await User.findByIdAndDelete(req.params.id);
  res.json({ message: 'User deleted' });
}));

// --- Hostel management ---
const HOSTEL_FIELDS = ['name', 'roomPrefix', 'roomDigits', 'isActive'];
const buildHostelPayload = (body) => {
  const payload = {};
  for (const field of HOSTEL_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  if (payload.roomPrefix !== undefined) payload.roomPrefix = String(payload.roomPrefix).trim();
  if (payload.roomDigits !== undefined) payload.roomDigits = Number(payload.roomDigits);
  return payload;
};

router.get('/hostels', asyncHandler(async (req, res) => {
  const hostels = await Hostel.find().sort({ name: 1 });
  res.json(hostels);
}));

router.post('/hostels', asyncHandler(async (req, res) => {
  const payload = buildHostelPayload(req.body);
  if (!payload.name || !payload.name.trim()) {
    return res.status(400).json({ message: 'Hostel name is required' });
  }
  if (payload.roomDigits !== undefined && (payload.roomDigits < 1 || payload.roomDigits > 6)) {
    return res.status(400).json({ message: 'Room digits must be between 1 and 6' });
  }
  const hostel = await Hostel.create(payload);
  res.status(201).json(hostel);
}));

router.patch('/hostels/:id', asyncHandler(async (req, res) => {
  const payload = buildHostelPayload(req.body);
  if (payload.roomDigits !== undefined && (payload.roomDigits < 1 || payload.roomDigits > 6)) {
    return res.status(400).json({ message: 'Room digits must be between 1 and 6' });
  }
  const hostel = await Hostel.findByIdAndUpdate(req.params.id, payload, { new: true });
  if (!hostel) return res.status(404).json({ message: 'Hostel not found' });
  res.json(hostel);
}));

router.delete('/hostels/:id', asyncHandler(async (req, res) => {
  const hostel = await Hostel.findByIdAndDelete(req.params.id);
  if (!hostel) return res.status(404).json({ message: 'Hostel not found' });
  res.json({ message: 'Hostel deleted' });
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

  const todaysOrders = await Order.find({ createdAt: { $gte: startOfDay } });

  const statusCounts = todaysOrders.reduce((acc, order) => {
    acc[order.status] = (acc[order.status] || 0) + 1;
    return acc;
  }, {});

  const itemCounts = {};
  for (const order of todaysOrders) {
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

  // All-time totals for the dashboard cards.
  const [revenueAgg, totalOrders, totalUsers, totalShops] = await Promise.all([
    Order.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: null, sum: { $sum: '$total' } } }
    ]),
    Order.countDocuments({ status: { $ne: 'cancelled' } }),
    User.countDocuments(),
    Shop.countDocuments({ isPermanentlyClosed: false }),
  ]);

  const totalRevenue = Math.round((revenueAgg[0]?.sum || 0) * 100) / 100;
  const todaysRevenue = Math.round(
    todaysOrders.filter(o => o.status !== 'cancelled').reduce((acc, o) => acc + o.total, 0) * 100
  ) / 100;

  res.json({
    totalRevenue,
    totalOrders,
    totalUsers,
    totalShops,
    todaysRevenue,
    statusCounts,
    popularItems,
  });
}));

module.exports = router;
