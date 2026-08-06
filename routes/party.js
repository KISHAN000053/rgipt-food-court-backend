const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const PartyRoom = require('../models/PartyRoom');
const MenuItem = require('../models/MenuItem');
const Shop = require('../models/Shop');
const Settings = require('../models/Settings');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { placeOrder } = require('../services/orderService');

router.use(requireAuth);

// Short, readable code — avoids ambiguous characters (0/O, 1/I).
const generateCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
};

const shapeRoom = (room, currentUserId) => {
  const isHost = String(room.host._id || room.host) === String(currentUserId);
  const subtotal = room.items.reduce((sum, i) => sum + i.price * i.quantity, 0);

  // Group items by the person who added them, for the host's reference.
  const byPerson = {};
  for (const item of room.items) {
    const key = String(item.addedBy);
    if (!byPerson[key]) {
      byPerson[key] = { name: item.addedByName, userId: key, items: [], subtotal: 0 };
    }
    byPerson[key].items.push({
      _id: item._id,
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      shopName: item.shopName,
      isMine: String(item.addedBy) === String(currentUserId),
    });
    byPerson[key].subtotal += item.price * item.quantity;
  }

  return {
    code: room.code,
    name: room.name,
    status: room.status,
    isHost,
    hostName: room.host.name || '',
    orderGroupId: room.orderGroupId,
    participants: Object.values(byPerson).map(p => ({
      ...p,
      subtotal: Math.round(p.subtotal * 100) / 100,
    })),
    itemCount: room.items.reduce((n, i) => n + i.quantity, 0),
    subtotal: Math.round(subtotal * 100) / 100,
  };
};

// Host creates a room.
router.post('/', asyncHandler(async (req, res) => {
  const { name } = req.body;

  let code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCode();
    const clash = await PartyRoom.findOne({ code: candidate });
    if (!clash) { code = candidate; break; }
  }
  if (!code) {
    return res.status(500).json({ message: 'Could not create a room right now. Please try again.' });
  }

  const room = await PartyRoom.create({
    code,
    name: (name || '').trim() || 'Party Order',
    host: req.user._id,
    items: [],
  });

  res.status(201).json(shapeRoom({ ...room.toObject(), host: req.user }, req.user._id));
}));

// Rooms this user hosts or has added items to.
router.get('/mine', asyncHandler(async (req, res) => {
  const rooms = await PartyRoom.find({
    $or: [{ host: req.user._id }, { 'items.addedBy': req.user._id }],
    status: 'open',
  }).sort({ createdAt: -1 }).populate('host', 'name');

  res.json(rooms.map(r => shapeRoom(r, req.user._id)));
}));

// View a room by code (any logged-in user with the code can join/view).
router.get('/:code', asyncHandler(async (req, res) => {
  const room = await PartyRoom.findOne({ code: req.params.code.toUpperCase() }).populate('host', 'name');
  if (!room) return res.status(404).json({ message: 'Party room not found. Check the code and try again.' });

  // Prices are stored when an item is added, but checkout charges the live menu price.
  // Re-sync here so the total the host sees is always the total they'll actually pay.
  if (room.status === 'open' && room.items.length > 0) {
    const ids = room.items.map(i => i.menuItem);
    const liveItems = await MenuItem.find({ _id: { $in: ids } });
    const priceMap = new Map(liveItems.map(m => [String(m._id), m.price]));
    let changed = false;
    for (const item of room.items) {
      const livePrice = priceMap.get(String(item.menuItem));
      if (livePrice !== undefined && livePrice !== item.price) {
        item.price = livePrice;
        changed = true;
      }
    }
    if (changed) await room.save();
  }

  const settings = await Settings.getGlobal();
  const shaped = shapeRoom(room, req.user._id);
  shaped.serviceFee = settings.serviceFee;
  shaped.surchargePercent = settings.razorpaySurchargePercent;
  res.json(shaped);
}));

// A guest (or host) adds an item.
router.post('/:code/items', asyncHandler(async (req, res) => {
  const { menuItemId, quantity } = req.body;
  const room = await PartyRoom.findOne({ code: req.params.code.toUpperCase() });
  if (!room) return res.status(404).json({ message: 'Party room not found.' });
  if (room.status !== 'open') return res.status(400).json({ message: 'This party order has already been placed.' });

  const menuItem = await MenuItem.findOne({ _id: menuItemId, isEnabled: true, isAvailable: true });
  if (!menuItem) return res.status(400).json({ message: 'That item is not available.' });

  const shop = await Shop.findById(menuItem.shop);
  if (!shop || !shop.isOpen || shop.isPermanentlyClosed) {
    return res.status(400).json({ message: 'That shop is currently closed.' });
  }

  const qty = Math.max(1, Number(quantity) || 1);

  // If this person already added the same item, just bump the quantity.
  const existing = room.items.find(i =>
    String(i.menuItem) === String(menuItem._id) && String(i.addedBy) === String(req.user._id)
  );
  if (existing) {
    existing.quantity += qty;
  } else {
    room.items.push({
      menuItem: menuItem._id,
      name: menuItem.name,
      price: menuItem.price,
      shop: shop._id,
      shopName: shop.name,
      quantity: qty,
      addedBy: req.user._id,
      addedByName: req.user.name,
    });
  }

  await room.save();
  await room.populate('host', 'name');
  res.json(shapeRoom(room, req.user._id));
}));

// Remove an item — guests can remove their own, the host can remove anything.
router.delete('/:code/items/:itemId', asyncHandler(async (req, res) => {
  const room = await PartyRoom.findOne({ code: req.params.code.toUpperCase() });
  if (!room) return res.status(404).json({ message: 'Party room not found.' });
  if (room.status !== 'open') return res.status(400).json({ message: 'This party order has already been placed.' });

  const item = room.items.id(req.params.itemId);
  if (!item) return res.status(404).json({ message: 'Item not found in this room.' });

  const isHost = String(room.host) === String(req.user._id);
  const isOwnItem = String(item.addedBy) === String(req.user._id);
  if (!isHost && !isOwnItem) {
    return res.status(403).json({ message: 'You can only remove items you added.' });
  }

  item.deleteOne();
  await room.save();
  await room.populate('host', 'name');
  res.json(shapeRoom(room, req.user._id));
}));

// Host places the order for the whole room and locks it.
router.post('/:code/checkout', asyncHandler(async (req, res) => {
  const { orderType, paymentMethod } = req.body;
  const room = await PartyRoom.findOne({ code: req.params.code.toUpperCase() });
  if (!room) return res.status(404).json({ message: 'Party room not found.' });
  if (String(room.host) !== String(req.user._id)) {
    return res.status(403).json({ message: 'Only the host can place this order.' });
  }
  if (room.status !== 'open') return res.status(400).json({ message: 'This party order has already been placed.' });
  if (room.items.length === 0) return res.status(400).json({ message: 'Nobody has added anything yet.' });

  // Guests may each add the same dish. Consolidate into one line per menu item so the
  // shop receives a single clean order (e.g. "3x Samosa", not three separate lines).
  const consolidated = new Map();
  for (const i of room.items) {
    const key = String(i.menuItem);
    if (!consolidated.has(key)) {
      consolidated.set(key, { menuItemId: i.menuItem, quantity: 0, names: new Set() });
    }
    const entry = consolidated.get(key);
    entry.quantity += i.quantity;
    if (i.addedByName) entry.names.add(i.addedByName);
  }

  const result = await placeOrder({
    user: req.user,
    items: Array.from(consolidated.values()).map(e => ({
      menuItemId: e.menuItemId,
      quantity: e.quantity,
      addedByName: Array.from(e.names).join(', '),
    })),
    orderType,
    paymentMethod,
    specialInstructions: `Party order (${room.code}) hosted by ${req.user.name}`,
    io: req.app.get('io'),
    partyCode: room.code,
  });

  if (!result.ok) {
    return res.status(result.status).json({ message: result.message });
  }

  room.status = 'ordered';
  room.orderGroupId = result.groupId;
  await room.save();

  res.status(201).json({ groupId: result.groupId, orders: result.orders });
}));

module.exports = router;
