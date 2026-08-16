const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const Order = require('../models/Order');
const MenuItem = require('../models/MenuItem');
const { requireShopOwner } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { CONFIRMED_PAYMENT_FILTER } = require('../utils/orderFilters');
const { refundOrderIfNeeded, validateStatusTransition } = require('../services/orderService');

router.use(requireShopOwner);

// The shop owner's own shop info — used to show name + open/closed state.
router.get('/shop', asyncHandler(async (req, res) => {
  res.json({
    _id: req.shop._id,
    name: req.shop.name,
    isOpen: req.shop.isOpen,
    isPermanentlyClosed: req.shop.isPermanentlyClosed,
    menuEditingEnabled: req.shop.menuEditingEnabled,
  });
}));

// Owner toggles their own shop online/offline whenever they want.
router.patch('/shop/status', asyncHandler(async (req, res) => {
  if (req.shop.isPermanentlyClosed) {
    return res.status(400).json({ message: 'This shop has been deactivated by an admin and cannot be reopened here.' });
  }
  const { isOpen } = req.body;
  req.shop.isOpen = !!isOpen;
  await req.shop.save();

  // Same live-update mechanism admin uses — students see it instantly.
  const io = req.app.get('io');
  if (io) io.emit('shopStatusChanged', { shopId: String(req.shop._id), isOpen: req.shop.isOpen, name: req.shop.name });

  res.json({ _id: req.shop._id, name: req.shop.name, isOpen: req.shop.isOpen });
}));

router.get('/orders', asyncHandler(async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  
  const orders = await Order.find({
    shop: req.shop._id,
    createdAt: { $gte: startOfDay },
    ...CONFIRMED_PAYMENT_FILTER,
  }).select('-pickupPin').sort({ createdAt: -1 }).populate('user', 'name phone roomNumber hostel');
  
  res.json(orders);
}));

router.get('/orders/pending', asyncHandler(async (req, res) => {
  const orders = await Order.find({
    shop: req.shop._id,
    status: { $in: ['pending', 'accepted', 'preparing'] },
    ...CONFIRMED_PAYMENT_FILTER,
  }).select('-pickupPin').sort({ createdAt: 1 }).populate('user', 'name phone roomNumber hostel');
  
  res.json(orders);
}));

router.patch('/orders/:id/status', asyncHandler(async (req, res) => {
  const { status, pin } = req.body;
  const existing = await Order.findOne({ _id: req.params.id, shop: req.shop._id });
  if (!existing) {
    return res.status(404).json({ message: 'Order not found' });
  }

  const check = validateStatusTransition({ order: existing, newStatus: status, providedPin: pin });
  if (!check.ok) {
    return res.status(400).json({ message: check.message });
  }

  existing.status = status;
  await existing.save();

  // Cancelling a paid order automatically refunds the food price (fees are kept).
  // This never blocks the cancellation itself — a refund failure is only marked
  // on the order for later follow-up.
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

router.get('/menu', asyncHandler(async (req, res) => {
  const items = await MenuItem.find({ shop: req.shop._id });
  res.json(items);
}));

const MENU_FIELDS = ['name', 'price', 'hasVariants', 'variants', 'category', 'description', 'isVeg', 'isAvailable', 'isEnabled', 'isAddon'];

// Shop owners may only change prices between 4:00 and 14:00 (IST). Everything else
// about an item (availability, name, category) can be edited any time.
// Admins are exempt so you can always correct a price.
const PRICE_WINDOW_START = 4;   // 4 AM
const PRICE_WINDOW_END = 14;    // 2 PM

const isWithinPriceWindow = () => {
  // Server runs in UTC on Render; convert to IST (UTC+5:30) for the campus-local window.
  const nowUtcMs = Date.now();
  const istMs = nowUtcMs + (5 * 60 + 30) * 60 * 1000;
  const istHour = new Date(istMs).getUTCHours();
  return istHour >= PRICE_WINDOW_START && istHour < PRICE_WINDOW_END;
};

const priceWindowMessage = 'Prices can only be changed between 4:00 AM and 2:00 PM. You can still update availability and other details.';

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

// Compares an existing item's pricing against an incoming payload — used to decide
// whether the 4am-2pm window applies. Works whether the item is single-price or
// switching between single/variant, or editing variant prices.
function hasPriceChanged(existing, payload) {
  const willHaveVariants = payload.hasVariants !== undefined ? payload.hasVariants : existing.hasVariants;
  if (willHaveVariants) {
    const newVariants = payload.variants !== undefined ? payload.variants : existing.variants;
    const oldVariants = existing.variants || [];
    if (newVariants.length !== oldVariants.length) return true;
    return newVariants.some((v, idx) => Number(v.price) !== Number(oldVariants[idx]?.price));
  }
  if (payload.price === undefined) return false;
  return Number(existing.price) !== Number(payload.price);
}

const buildMenuPayload = (body) => {
  const payload = {};
  for (const field of MENU_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  if (payload.isAddon) {
    payload.category = 'Add-ons';
    payload.hasVariants = false;
    payload.variants = [];
  }
  return payload;
};

router.post('/menu', asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin' && !req.shop.menuEditingEnabled) {
    return res.status(403).json({ message: 'Menu editing has been restricted by admin for your shop. Contact admin to add items.' });
  }
  const payload = buildMenuPayload(req.body);
  if (!payload.name) {
    return res.status(400).json({ message: 'Name is required' });
  }
  if (!payload.isAddon && !payload.category) {
    return res.status(400).json({ message: 'Category is required' });
  }
  if (!payload.hasVariants && payload.price === undefined) {
    return res.status(400).json({ message: 'Price is required' });
  }
  const pricingError = validateMenuPricing(payload);
  if (pricingError) return res.status(400).json({ message: pricingError });
  if (req.user.role !== 'admin' && !isWithinPriceWindow()) {
    return res.status(403).json({ message: 'New items can only be added between 4:00 AM and 2:00 PM.' });
  }
  if (payload.hasVariants) payload.price = 0;
  const item = await MenuItem.create({ ...payload, shop: req.shop._id });
  res.status(201).json(item);
}));

router.delete('/menu/:itemId', asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin' && !req.shop.menuEditingEnabled) {
    return res.status(403).json({ message: 'Menu editing has been restricted by admin for your shop. Contact admin to remove items.' });
  }
  const item = await MenuItem.findOneAndDelete({ _id: req.params.itemId, shop: req.shop._id });
  if (!item) {
    return res.status(404).json({ message: 'Menu item not found' });
  }
  res.json({ message: 'Menu item deleted' });
}));

router.patch('/menu/:itemId', asyncHandler(async (req, res) => {
  const payload = buildMenuPayload(req.body);

  if (req.user.role !== 'admin' && !req.shop.menuEditingEnabled) {
    // Even when restricted, a shop owner can still mark something in/out of stock —
    // that's day-to-day operations, not "editing the menu". Anything beyond that
    // (name, category, price, variants, description) is blocked.
    const onlyTouchesAvailability = Object.keys(payload).every(k => k === 'isAvailable');
    if (!onlyTouchesAvailability) {
      return res.status(403).json({ message: 'Menu editing has been restricted by admin for your shop. You can still mark items in or out of stock. Contact admin for other changes.' });
    }
  }

  const pricingError = validateMenuPricing(payload);
  if (pricingError) return res.status(400).json({ message: pricingError });

  const existing = await MenuItem.findOne({ _id: req.params.itemId, shop: req.shop._id });
  if (!existing) {
    return res.status(404).json({ message: 'Menu item not found' });
  }

  if (req.user.role !== 'admin' && hasPriceChanged(existing, payload) && !isWithinPriceWindow()) {
    return res.status(403).json({ message: priceWindowMessage });
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
    status: { $ne: 'cancelled' },
    ...CONFIRMED_PAYMENT_FILTER,
  });
  
  const revenue = orders.reduce((acc, order) => acc + order.total, 0);
  
  res.json({
    orderCount: orders.length,
    revenue
  });
}));

// Downloadable payout statement (.xlsx) for a date range — an "Annexure" like the
// ones Swiggy/Zomato provide, but honest about what our platform actually does:
// no commission, no ads, no coupons, no GST computation. Includes both completed
// AND cancelled orders in the period, since a shop owner should be able to see
// exactly which orders were cancelled and why their payout is what it is — a
// cancelled order legitimately pays ₹0 (the student was refunded), not an error.
router.get('/report/annexure', asyncHandler(async (req, res) => {
  const { from, to } = req.query;

  const dateMatch = {};
  if (from || to) {
    dateMatch.createdAt = {};
    if (from) dateMatch.createdAt.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      dateMatch.createdAt.$lte = end;
    }
  }

  const orders = await Order.find({
    shop: req.shop._id,
    ...CONFIRMED_PAYMENT_FILTER, // still excludes abandoned/unpaid checkouts — those never happened
    ...dateMatch,
  }).sort({ createdAt: 1 }).populate('user', 'name');

  const delivered = orders.filter(o => o.status !== 'cancelled');
  const cancelled = orders.filter(o => o.status === 'cancelled');

  const deliveredTotal = Math.round(delivered.reduce((s, o) => s + o.subtotal, 0) * 100) / 100;
  const refundedTotal = Math.round(cancelled.reduce((s, o) => s + (o.refundAmount ?? o.subtotal), 0) * 100) / 100;
  const netPayout = deliveredTotal; // cancelled orders contribute ₹0 — matches the Payouts page exactly

  // Split what's already landed in this shop's own account automatically (Route)
  // from what still needs a manual transfer — a shop could have both if they were
  // only linked to Route partway through the period being viewed.
  const autoPaidOrders = delivered.filter(o => o.routeTransferId);
  const manualOrders = delivered.filter(o => !o.routeTransferId);
  const autoPaidTotal = Math.round(autoPaidOrders.reduce((s, o) => s + o.subtotal, 0) * 100) / 100;
  const manualOwedTotal = Math.round(manualOrders.reduce((s, o) => s + o.subtotal, 0) * 100) / 100;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'RGIPT Food Court';
  workbook.created = new Date();

  const FONT = { name: 'Arial', size: 10 };
  const HEADER_FONT = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEA5B26' } };
  const CURRENCY_FMT = '₹#,##0.00;-₹#,##0.00;-';

  // --- Sheet 1: Summary ---
  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 4 }, { width: 32 }, { width: 24 }];
  summary.getCell('B2').value = 'RGIPT Food Court — Payout Statement';
  summary.getCell('B2').font = { name: 'Arial', size: 14, bold: true };
  summary.getCell('B4').value = 'Shop Name';
  summary.getCell('C4').value = req.shop.name;
  summary.getCell('B5').value = 'Payout Period';
  summary.getCell('C5').value = `${from || 'All time'} to ${to || 'today'}`;
  summary.getCell('B6').value = 'Generated On';
  summary.getCell('C6').value = new Date().toLocaleDateString('en-IN');
  summary.getCell('B8').value = 'Delivered / Active Orders';
  summary.getCell('C8').value = delivered.length;
  summary.getCell('B9').value = 'Cancelled Orders';
  summary.getCell('C9').value = cancelled.length;
  summary.getCell('B10').value = 'Total Orders';
  summary.getCell('C10').value = { formula: 'C8+C9', result: delivered.length + cancelled.length };
  summary.getCell('B12').value = 'Total Payout';
  summary.getCell('B12').font = { name: 'Arial', size: 12, bold: true };
  summary.getCell('C12').value = { formula: "'Payout Breakup'!D6", result: netPayout };
  summary.getCell('C12').font = { name: 'Arial', size: 12, bold: true };
  summary.getCell('C12').numFmt = CURRENCY_FMT;
  summary.getCell('B13').value = '  — Already received automatically';
  summary.getCell('C13').value = autoPaidTotal;
  summary.getCell('C13').numFmt = CURRENCY_FMT;
  summary.getCell('B14').value = '  — Still owed (manual transfer)';
  summary.getCell('C14').value = manualOwedTotal;
  summary.getCell('C14').numFmt = CURRENCY_FMT;
  summary.getCell('B15').value = 'RGIPT Food Court charges no commission on your sales — you receive your full listed';
  summary.getCell('B16').value = 'price for every completed order. Cancelled orders are refunded to the student in full';
  summary.getCell('B17').value = '(food price only) and are not included in your payout.';
  for (const row of [4, 5, 6, 8, 9, 10, 13, 14, 15, 16, 17]) {
    summary.getRow(row).font = FONT;
  }

  // --- Sheet 2: Payout Breakup (simple — no commission/ads/tax deductions exist on this platform) ---
  const breakup = workbook.addWorksheet('Payout Breakup');
  breakup.columns = [{ width: 4 }, { width: 34 }, { width: 18 }, { width: 18 }, { width: 18 }];
  breakup.getCell('B2').value = 'Payout Breakup';
  breakup.getCell('B2').font = { name: 'Arial', size: 12, bold: true };
  const breakupHeaderRow = breakup.getRow(4);
  breakupHeaderRow.values = ['', 'Particulars', 'Delivered Orders', 'Cancelled Orders', 'Total'];
  for (let c = 2; c <= 5; c++) {
    const cell = breakupHeaderRow.getCell(c);
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
  }
  breakup.getCell('B5').value = 'Orders';
  breakup.getCell('C5').value = delivered.length;
  breakup.getCell('D5').value = cancelled.length;
  breakup.getCell('E5').value = { formula: 'C5+D5', result: delivered.length + cancelled.length };

  breakup.getCell('B6').value = 'Item Sales Total';
  breakup.getCell('C6').value = deliveredTotal;
  breakup.getCell('D6').value = 0;
  breakup.getCell('E6').value = { formula: 'C6+D6', result: deliveredTotal };

  breakup.getCell('B7').value = 'Refunded to Student (cancelled orders)';
  breakup.getCell('C7').value = 0;
  breakup.getCell('D7').value = -refundedTotal;
  breakup.getCell('E7').value = { formula: 'C7+D7', result: -refundedTotal };

  breakup.getCell('B8').value = 'Total Payout to You';
  breakup.getCell('B8').font = { name: 'Arial', size: 10, bold: true };
  breakup.getCell('C8').value = { formula: 'C6+C7', result: deliveredTotal };
  breakup.getCell('D8').value = { formula: 'D6+D7', result: 0 };
  breakup.getCell('E8').value = { formula: 'C8+D8', result: netPayout };
  for (const col of ['C8', 'D8', 'E8']) breakup.getCell(col).font = { name: 'Arial', size: 10, bold: true };
  for (const col of ['C6', 'D6', 'E6', 'C7', 'D7', 'E7', 'C8', 'D8', 'E8']) {
    breakup.getCell(col).numFmt = CURRENCY_FMT;
  }
  for (const row of [5, 6, 7, 8]) breakup.getRow(row).font = FONT;

  // --- Sheet 3: Order Level ---
  const orderSheet = workbook.addWorksheet('Order Level');
  orderSheet.columns = [
    { header: 'Order ID', key: 'orderId', width: 12 },
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Customer', key: 'customer', width: 18 },
    { header: 'Order Type', key: 'type', width: 12 },
    { header: 'Items', key: 'items', width: 45 },
    { header: 'Item Subtotal', key: 'subtotal', width: 14 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Refunded to Student', key: 'refunded', width: 18 },
    { header: 'Payout to You', key: 'payout', width: 14 },
    { header: 'Payment Received', key: 'paymentReceived', width: 22 },
  ];
  orderSheet.getRow(1).eachCell(cell => {
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
  });

  const statusLabels = {
    pending: 'Pending', accepted: 'Accepted', preparing: 'Preparing',
    delivery_initiated: 'Completed', cancelled: 'Cancelled',
  };

  for (const o of orders) {
    const isCancelled = o.status === 'cancelled';
    orderSheet.addRow({
      orderId: o._id.toString().slice(-6).toUpperCase(),
      date: o.createdAt.toLocaleDateString('en-IN'),
      customer: o.user?.name || '',
      type: o.orderType === 'takeaway' ? 'Takeaway' : 'Hostel',
      items: o.items.map(i => `${i.quantity}x ${i.name}${i.variantName ? ` (${i.variantName})` : ''}`).join('; '),
      subtotal: o.subtotal,
      status: statusLabels[o.status] || o.status,
      refunded: isCancelled ? (o.refundAmount ?? o.subtotal) : 0,
      payout: isCancelled ? 0 : o.subtotal,
      paymentReceived: isCancelled ? '—' : (o.routeTransferId ? 'Received automatically' : 'Still owed — manual transfer'),
    }).font = FONT;
  }

  const totalRowNum = orders.length + 2;
  const totalRow = orderSheet.getRow(totalRowNum);
  totalRow.getCell('items').value = 'Total';
  totalRow.getCell('subtotal').value = orders.length ? { formula: `SUM(F2:F${totalRowNum - 1})`, result: deliveredTotal + refundedTotal } : 0;
  totalRow.getCell('refunded').value = orders.length ? { formula: `SUM(H2:H${totalRowNum - 1})`, result: refundedTotal } : 0;
  totalRow.getCell('payout').value = orders.length ? { formula: `SUM(I2:I${totalRowNum - 1})`, result: netPayout } : 0;
  totalRow.font = { name: 'Arial', size: 10, bold: true };

  orderSheet.getColumn('subtotal').numFmt = CURRENCY_FMT;
  orderSheet.getColumn('refunded').numFmt = CURRENCY_FMT;
  orderSheet.getColumn('payout').numFmt = CURRENCY_FMT;

  const filename = `payout-statement_${(from || 'all').replace(/-/g, '')}_to_${(to || 'today').replace(/-/g, '')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}));

// Order report for a date range. "earnings" = the shop's own subtotal (their prices),
// which is what they actually get paid — platform fees are excluded.
router.get('/report', asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const match = { shop: req.shop._id, status: { $ne: 'cancelled' }, ...CONFIRMED_PAYMENT_FILTER };

  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      match.createdAt.$lte = end;
    }
  }

  const orders = await Order.find(match).sort({ createdAt: -1 }).populate('user', 'name');

  const rows = orders.map(o => ({
    orderId: o._id.toString().slice(-6).toUpperCase(),
    date: o.createdAt,
    customer: o.user?.name || '',
    type: o.orderType === 'takeaway' ? 'Takeaway' : 'Hostel',
    items: o.items.map(i => `${i.quantity}x ${i.name}`).join('; '),
    earnings: Math.round(o.subtotal * 100) / 100,
    // Whether this specific order already paid automatically (Route) or is still
    // waiting on a manual transfer — a shop can have both if they were only linked
    // partway through the period being viewed.
    paidAutomatically: !!o.routeTransferId,
  }));

  const totalEarnings = Math.round(rows.reduce((sum, r) => sum + r.earnings, 0) * 100) / 100;
  const totalAutoPaid = Math.round(rows.filter(r => r.paidAutomatically).reduce((sum, r) => sum + r.earnings, 0) * 100) / 100;
  const totalManualOwed = Math.round((totalEarnings - totalAutoPaid) * 100) / 100;

  res.json({ rows, totalEarnings, totalAutoPaid, totalManualOwed, orderCount: rows.length });
}));

module.exports = router;
