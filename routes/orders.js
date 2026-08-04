const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const MenuItem = require('../models/MenuItem');
const Shop = require('../models/Shop');
const Settings = require('../models/Settings');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const crypto = require('crypto');

const withMarkup = (basePrice, surchargePercent) => {
  return Math.round(basePrice * (1 + surchargePercent / 100) * 100) / 100;
};

// Cart items can come from multiple shops. We split them into one Order per shop
// (so each shop's kitchen only ever sees its own items) but link them with a shared
// groupId and charge the service fee only once across the whole checkout, so it reads
// as a single order to the student even though it's stored as several documents.
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const { items, specialInstructions, paymentMethod } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'Cart is empty' });
  }

  const settings = await Settings.getGlobal();

  // Fetch all menu items up front and group by shop.
  const menuItemIds = items.map(i => i.menuItemId);
  const menuItems = await MenuItem.find({ _id: { $in: menuItemIds }, isEnabled: true, isAvailable: true });
  const menuItemMap = new Map(menuItems.map(m => [String(m._id), m]));

  const byShop = new Map(); // shopId -> [{ menuItem, quantity }]
  for (const cartItem of items) {
    const menuItem = menuItemMap.get(String(cartItem.menuItemId));
    if (!menuItem) {
      return res.status(400).json({ message: `Item ${cartItem.menuItemId} is not available` });
    }
    const shopKey = String(menuItem.shop);
    if (!byShop.has(shopKey)) byShop.set(shopKey, []);
    byShop.get(shopKey).push({ menuItem, quantity: cartItem.quantity });
  }

  const shopIds = Array.from(byShop.keys());
  const shops = await Shop.find({ _id: { $in: shopIds } });
  const shopMap = new Map(shops.map(s => [String(s._id), s]));

  // Validate every shop before creating anything (so we never charge for a partially-failed cart).
  for (const shopId of shopIds) {
    const shop = shopMap.get(shopId);
    if (!shop || !shop.isOpen || shop.isPermanentlyClosed) {
      return res.status(400).json({ message: `${shop?.name || 'A shop'} in your cart is currently unavailable` });
    }
    const shopSubtotal = byShop.get(shopId).reduce((sum, { menuItem, quantity }) => {
      return sum + withMarkup(menuItem.price, settings.razorpaySurchargePercent) * quantity;
    }, 0);
    if (shopSubtotal < (shop.minOrder || 0)) {
      return res.status(400).json({ message: `Minimum order for ${shop.name} is ₹${shop.minOrder}` });
    }
  }

  const groupId = 'GRP-' + crypto.randomBytes(6).toString('hex');
  const createdOrders = [];

  for (let i = 0; i < shopIds.length; i++) {
    const shopId = shopIds[i];
    const shop = shopMap.get(shopId);
    const cartLines = byShop.get(shopId);

    let subtotal = 0;
    const orderItems = cartLines.map(({ menuItem, quantity }) => {
      const chargedPrice = withMarkup(menuItem.price, settings.razorpaySurchargePercent);
      subtotal += chargedPrice * quantity;
      return {
        menuItem: menuItem._id,
        name: menuItem.name,
        price: chargedPrice,
        basePrice: menuItem.price,
        quantity
      };
    });

    // Only the first shop in the group carries the one-time service fee.
    const serviceFee = i === 0 ? settings.serviceFee : 0;
    const total = Math.round((subtotal + serviceFee) * 100) / 100;
    const orderNumber = 'ORD-' + String(Date.now() % 1000000).padStart(6, '0') + '-' + i;

    const order = await Order.create({
      orderNumber,
      groupId,
      user: req.user._id,
      shop: shopId,
      items: orderItems,
      subtotal,
      serviceFee,
      total,
      paymentMethod: paymentMethod || 'cash',
      specialInstructions
    });

    createdOrders.push(order);

    const io = req.app.get('io');
    if (io) {
      io.to(`shop-${shopId}`).emit('newOrder', order);
    }
  }

  res.status(201).json({ groupId, orders: createdOrders });
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
