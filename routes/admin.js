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
const { CONFIRMED_PAYMENT_FILTER } = require('../utils/orderFilters');
const { refundOrderIfNeeded, validateStatusTransition } = require('../services/orderService');
const asyncHandler = require('../middleware/asyncHandler');

router.use(requireAdmin);

router.get('/payouts', asyncHandler(async (req, res) => {
  // Per-shop performance — order count and revenue, plus whether each shop is
  // linked to Route. "Owed" only matters for a shop that ISN'T linked yet; once
  // every shop is linked, this number naturally settles at ₹0 for all of them,
  // which is correct, not broken.
  const payouts = await Order.aggregate([
    { $match: { status: { $ne: 'cancelled' }, ...CONFIRMED_PAYMENT_FILTER } },
    {
      $group: {
        _id: '$shop',
        autoPaidAmount: { $sum: { $cond: [{ $ifNull: ['$routeTransferId', false] }, '$subtotal', 0] } },
        manualOwedAmount: { $sum: { $cond: [{ $ifNull: ['$routeTransferId', false] }, 0, '$subtotal'] } },
        orderIds: { $addToSet: '$_id' },
      }
    },
    { $lookup: { from: 'shops', localField: '_id', foreignField: '_id', as: 'shop' } },
    { $unwind: { path: '$shop', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        shopId: '$_id',
        shopName: { $ifNull: ['$shop.name', 'Deleted shop'] },
        isLinked: { $ne: [{ $ifNull: ['$shop.razorpayLinkedAccountId', null] }, null] },
        autoPaidAmount: { $round: ['$autoPaidAmount', 2] },
        manualOwedAmount: { $round: ['$manualOwedAmount', 2] },
        orderCount: { $size: '$orderIds' },
      }
    },
    { $sort: { shopName: 1 } }
  ]);

  const feeAgg = await Order.aggregate([
    { $match: { status: { $ne: 'cancelled' }, ...CONFIRMED_PAYMENT_FILTER } },
    { $group: {
      _id: null,
      totalServiceFees: { $sum: '$serviceFee' },
      totalProcessingFees: { $sum: '$processingFee' },
    } }
  ]);
  const totalServiceFees = Math.round((feeAgg[0]?.totalServiceFees || 0) * 100) / 100;
  const totalMarkupRevenue = Math.round((feeAgg[0]?.totalProcessingFees || 0) * 100) / 100;

  // Anomalies — a paid, non-cancelled order whose shop IS linked to Route, but
  // which somehow never got a routeTransferId recorded. This is exactly the
  // shape of bug that was silently missing transfer records a few days ago —
  // this section exists so a repeat of that gets caught here automatically,
  // rather than only being found by accident when a cancellation goes wrong.
  const linkedShopIds = (await Shop.find({ razorpayLinkedAccountId: { $ne: null } }, '_id')).map(s => s._id);
  const anomalies = await Order.find({
    shop: { $in: linkedShopIds },
    status: { $ne: 'cancelled' },
    paymentStatus: 'paid',
    routeTransferId: { $in: [null, undefined] },
  }).populate('shop', 'name').sort({ createdAt: -1 }).limit(50);

  // Refunds that failed to reverse the shop's share automatically — these need
  // you to sort out manually, same as before, just surfaced here directly
  // instead of only showing up buried in individual order detail pages.
  const failedRefunds = await Order.find({ refundStatus: 'failed' })
    .populate('shop', 'name').populate('user', 'name email').sort({ createdAt: -1 }).limit(50);

  res.json({
    payouts,
    anomalies: anomalies.map(o => ({
      orderId: o._id, shopName: o.shop?.name || 'Unknown', total: o.total, createdAt: o.createdAt,
    })),
    failedRefunds: failedRefunds.map(o => ({
      orderId: o._id, shopName: o.shop?.name || 'Unknown', customerEmail: o.user?.email || '',
      refundAmount: o.refundAmount, reason: o.refundFailReason, createdAt: o.createdAt,
    })),
    summary: {
      // "Owed" now means only what genuinely still needs a manual transfer from you —
      // amounts already auto-paid via Route are excluded, on purpose.
      totalOwedToShops: Math.round(payouts.reduce((sum, p) => sum + p.manualOwedAmount, 0) * 100) / 100,
      totalAutoPaidToShops: Math.round(payouts.reduce((sum, p) => sum + p.autoPaidAmount, 0) * 100) / 100,
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

const SHOP_FIELDS = ['name', 'description', 'isOpen', 'isPermanentlyClosed', 'menuEditPolicy', 'ownerEmail', 'categories', 'razorpayLinkedAccountId'];

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

  // Tell every connected browser immediately, so students see a shop going
  // offline without needing to reload.
  const io = req.app.get('io');
  if (io) io.emit('shopStatusChanged', { shopId: String(shop._id), isOpen: shop.isOpen, name: shop.name });

  res.json(shop);
}));

router.delete('/shops/:id', asyncHandler(async (req, res) => {
  await Shop.findByIdAndUpdate(req.params.id, { isPermanentlyClosed: true, isOpen: false });
  const io = req.app.get('io');
  if (io) io.emit('shopStatusChanged', { shopId: String(req.params.id), isOpen: false });
  res.json({ message: 'Shop softly deleted' });
}));

router.delete('/shops/:id/permanent', asyncHandler(async (req, res) => {
  const { confirmName } = req.body;
  const shop = await Shop.findById(req.params.id);
  if (!shop) return res.status(404).json({ message: 'Shop not found' });
  if (confirmName !== shop.name) {
    return res.status(400).json({ message: 'Shop name did not match — nothing was deleted.' });
  }
  await MenuItem.deleteMany({ shop: shop._id });
  await Shop.findByIdAndDelete(shop._id);
  const io = req.app.get('io');
  if (io) io.emit('shopStatusChanged', { shopId: String(req.params.id), isOpen: false });
  res.json({ message: `${shop.name} permanently deleted.` });
}));

router.get('/menu/:shopId', asyncHandler(async (req, res) => {
  const items = await MenuItem.find({ shop: req.params.shopId });
  res.json(items);
}));

// Shared by admin and shop-owner menu routes — validates a create/edit payload for
// either a single-price item or a multi-price (variant) item. Variant names are
// optional; prices are required and must be non-negative. At least 2 variants are
// required when hasVariants is true (otherwise it isn't really "multiple").
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

const ADMIN_MENU_FIELDS = ['name', 'price', 'hasVariants', 'variants', 'category', 'description', 'isVeg', 'isAvailable', 'isEnabled', 'isAddon', 'shop'];
const buildAdminMenuPayload = (body) => {
  const payload = {};
  for (const field of ADMIN_MENU_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  // Add-ons don't have a meaningful category or variant pricing — keep them simple.
  if (payload.isAddon) {
    payload.category = 'Add-ons';
    payload.hasVariants = false;
    payload.variants = [];
  }
  return payload;
};

router.post('/menu', asyncHandler(async (req, res) => {
  const payload = buildAdminMenuPayload(req.body);
  if (!payload.name || !payload.shop) {
    return res.status(400).json({ message: 'Name and shop are required' });
  }
  if (!payload.isAddon && !payload.category) {
    return res.status(400).json({ message: 'Category is required' });
  }
  if (!payload.hasVariants && payload.price === undefined) {
    return res.status(400).json({ message: 'Price is required' });
  }
  const pricingError = validateMenuPricing(payload);
  if (pricingError) return res.status(400).json({ message: pricingError });
  if (payload.hasVariants) payload.price = 0; // unused in variant mode, keep schema clean
  const item = await MenuItem.create(payload);
  res.status(201).json(item);
}));

router.patch('/menu/:id', asyncHandler(async (req, res) => {
  const payload = buildAdminMenuPayload(req.body);
  const pricingError = validateMenuPricing(payload);
  if (pricingError) return res.status(400).json({ message: pricingError });
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
  const ownsShop = await Shop.findOne({ ownerEmail: target.email.toLowerCase() });
  if (ownsShop) {
    return res.status(400).json({ message: `This account owns "${ownsShop.name}". Unassign it from the shop first, then delete.` });
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
  const orders = await Order.find(CONFIRMED_PAYMENT_FILTER).select('-pickupPin').sort({ createdAt: -1 }).populate('shop', 'name').populate('user', 'name email');
  res.json(orders);
}));

// Admin can update ANY order's status, regardless of which shop it belongs to —
// separate from the shop-owner route since a shop owner can only touch their own.
router.patch('/orders/:id/status', asyncHandler(async (req, res) => {
  const { status, pin } = req.body;
  const existing = await Order.findById(req.params.id);
  if (!existing) {
    return res.status(404).json({ message: 'Order not found' });
  }

  const check = validateStatusTransition({ order: existing, newStatus: status, providedPin: pin });
  if (!check.ok) {
    return res.status(400).json({ message: check.message });
  }

  existing.status = status;
  await existing.save();

  if (status === 'cancelled') {
    await refundOrderIfNeeded(existing);
  }

  const io = req.app.get('io');
  if (io) {
    io.to(`user-${existing.user}`).emit('orderStatusChanged', existing);
  }

  const responseOrder = existing.toObject();
  delete responseOrder.pickupPin;
  res.json(responseOrder);
}));

router.post('/announcements', asyncHandler(async (req, res) => {
  const announcement = await Announcement.create(req.body);
  res.status(201).json(announcement);
}));

router.get('/analytics', asyncHandler(async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const todaysOrders = await Order.find({ createdAt: { $gte: startOfDay }, ...CONFIRMED_PAYMENT_FILTER });

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
      { $match: { status: { $ne: 'cancelled' }, ...CONFIRMED_PAYMENT_FILTER } },
      { $group: { _id: null, sum: { $sum: '$total' } } }
    ]),
    Order.countDocuments({ status: { $ne: 'cancelled' }, ...CONFIRMED_PAYMENT_FILTER }),
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
