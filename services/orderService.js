const crypto = require('crypto');
const Order = require('../models/Order');
const MenuItem = require('../models/MenuItem');
const Shop = require('../models/Shop');
const Settings = require('../models/Settings');

// Simple, shop-friendly flow: pending -> accepted -> [preparing] -> delivery_initiated.
// Preparing is optional — a shop can go straight from accepted to delivery_initiated.
// Cancelled is allowed from any non-terminal state. Shared between the shop-owner and
// admin order-status routes so the rules can never drift between them.
const ALLOWED_TRANSITIONS = {
  pending: ['accepted', 'cancelled'],
  accepted: ['preparing', 'delivery_initiated', 'cancelled'],
  preparing: ['delivery_initiated', 'cancelled'],
  delivery_initiated: [],
  cancelled: [],
};

// Resolves the actual price + display name for a cart line against its menu item.
// For a variant item, the student must have picked one of the item's options —
// otherwise this returns an error so checkout can't silently default to something.
function resolveLinePrice(menuItem, variantId) {
  if (!menuItem.hasVariants) {
    return { ok: true, price: menuItem.price, variantName: undefined };
  }
  const variant = menuItem.variants.id(variantId);
  if (!variant) {
    return { ok: false, message: `Please select an option for ${menuItem.name}.` };
  }
  return { ok: true, price: variant.price, variantName: variant.name || undefined };
}

/**
 * Validates a cart and computes exactly what it costs — WITHOUT writing anything to
 * the database. This is the only step that runs before payment. Nothing is saved to
 * the orders collection until payment is actually confirmed (see createOrdersFromPricedCart).
 *
 * @param {Object} opts
 * @param {Object} opts.user      - the paying user
 * @param {Array}  opts.items     - [{ menuItemId, quantity, variantId?, forProductName? }]
 * @param {String} opts.orderType - 'takeaway' | 'hostel'
 * @returns {Promise<{ok: true, type, byShop, totalRupees} | {ok: false, status, message}>}
 */
async function priceCart({ user, items, orderType }) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, status: 400, message: 'Cart is empty' };
  }

  const type = orderType === 'takeaway' ? 'takeaway' : 'hostel';

  if (type === 'hostel' && user.isJunior === false) {
    return { ok: false, status: 400, message: 'Hostel delivery is only available for Juniors. Please choose Takeaway instead.' };
  }
  if (type === 'hostel' && (!user.hostel || !user.roomNumber)) {
    return { ok: false, status: 400, message: 'Please set your hostel and room in your profile before ordering hostel delivery.' };
  }

  const settings = await Settings.getGlobal();

  const menuItemIds = items.map(i => i.menuItemId);
  const menuItems = await MenuItem.find({ _id: { $in: menuItemIds }, isEnabled: true, isAvailable: true });
  const menuItemMap = new Map(menuItems.map(m => [String(m._id), m]));

  const byShop = new Map();
  for (const cartItem of items) {
    const menuItem = menuItemMap.get(String(cartItem.menuItemId));
    if (!menuItem) {
      return { ok: false, status: 400, message: `Item ${cartItem.menuItemId} is not available` };
    }
    const resolved = resolveLinePrice(menuItem, cartItem.variantId);
    if (!resolved.ok) {
      return { ok: false, status: 400, message: resolved.message };
    }
    const shopKey = String(menuItem.shop);
    if (!byShop.has(shopKey)) byShop.set(shopKey, []);
    byShop.get(shopKey).push({
      menuItem,
      quantity: cartItem.quantity,
      forProductName: cartItem.forProductName,
      price: resolved.price,
      variantName: resolved.variantName,
    });
  }

  const shopIds = Array.from(byShop.keys());
  const shops = await Shop.find({ _id: { $in: shopIds } });
  const shopMap = new Map(shops.map(s => [String(s._id), s]));

  for (const shopId of shopIds) {
    const shop = shopMap.get(shopId);
    if (!shop || !shop.isOpen || shop.isPermanentlyClosed) {
      return { ok: false, status: 400, message: `${shop?.name || 'A shop'} in your cart is currently unavailable` };
    }
  }

  const cartSubtotal = Array.from(byShop.values()).reduce((sum, lines) => {
    return sum + lines.reduce((s, { price, quantity }) => s + price * quantity, 0);
  }, 0);
  const processingFeeTotal = Math.round(cartSubtotal * (settings.razorpaySurchargePercent / 100) * 100) / 100;
  const totalRupees = Math.round((cartSubtotal + settings.serviceFee + processingFeeTotal) * 100) / 100;

  return {
    ok: true,
    type,
    byShop,
    shopIds,
    serviceFee: settings.serviceFee,
    processingFeeTotal,
    totalRupees,
  };
}

/**
 * Actually writes orders to the database, from an already-priced cart. Only called
 * once payment is confirmed (paid) — this is the single place a row is ever created
 * in the orders collection, so nothing unpaid or abandoned ever lands there.
 *
 * @param {Object} opts
 * @param {Object} opts.user
 * @param {Object} opts.priced             - the result of priceCart({ ok: true, ... })
 * @param {String} opts.paymentMethod
 * @param {String} opts.razorpayOrderId
 * @param {String} opts.razorpayPaymentId
 * @param {String} opts.specialInstructions
 * @param {Object} opts.io
 * @returns {Promise<{groupId, orders}>}
 */
async function createOrdersFromPricedCart({ user, priced, paymentMethod, razorpayOrderId, razorpayPaymentId, specialInstructions, io }) {
  const { type, byShop, shopIds, serviceFee, processingFeeTotal } = priced;
  const groupId = 'GRP-' + crypto.randomBytes(6).toString('hex');
  const createdOrders = [];

  for (let i = 0; i < shopIds.length; i++) {
    const shopId = shopIds[i];
    const cartLines = byShop.get(shopId);

    let subtotal = 0;
    const orderItems = cartLines.map(({ menuItem, quantity, forProductName, price, variantName }) => {
      subtotal += price * quantity;
      return {
        menuItem: menuItem._id,
        name: menuItem.name,
        price,
        basePrice: price,
        quantity,
        variantName,
        isAddon: menuItem.isAddon || undefined,
        forProductName: forProductName || undefined,
      };
    });
    subtotal = Math.round(subtotal * 100) / 100;

    const lineServiceFee = i === 0 ? serviceFee : 0;
    const lineProcessingFee = i === 0 ? processingFeeTotal : 0;
    const total = Math.round((subtotal + lineServiceFee + lineProcessingFee) * 100) / 100;
    const orderNumber = 'ORD-' + String(Date.now() % 1000000).padStart(6, '0') + '-' + i;

    const order = await Order.create({
      orderNumber,
      groupId,
      user: user._id,
      shop: shopId,
      items: orderItems,
      orderType: type,
      subtotal,
      serviceFee: lineServiceFee,
      processingFee: lineProcessingFee,
      total,
      paymentMethod: paymentMethod || 'razorpay',
      paymentStatus: 'paid', // this function only ever runs after payment is confirmed
      razorpayOrderId,
      razorpayPaymentId,
      specialInstructions,
    });

    createdOrders.push(order);

    if (io) {
      io.to(`shop-${shopId}`).emit('newOrder', order);
    }
  }

  return { groupId, orders: createdOrders };
}

/**
 * Refunds the subtotal of a paid order (keeps service + processing fees) when it's
 * cancelled. Called automatically from the status-change route — never blocks the
 * cancellation itself. If the refund call fails, the order stays cancelled and is
 * marked refundStatus: 'failed' so it's visible, not silently lost.
 */
async function refundOrderIfNeeded(order) {
  if (order.paymentMethod !== 'razorpay' || order.paymentStatus !== 'paid') return;
  if (order.refundStatus === 'processing' || order.refundStatus === 'completed') return;
  if (!order.razorpayPaymentId || !order.subtotal || order.subtotal <= 0) return;

  const { createRefund } = require('./razorpayService');

  try {
    const refund = await createRefund({
      paymentId: order.razorpayPaymentId,
      amountRupees: order.subtotal,
      notes: { orderId: String(order._id), reason: 'Order cancelled — food price refunded, fees kept' },
    });
    order.refundStatus = 'processing';
    order.refundId = refund.id;
    order.refundAmount = order.subtotal;
    await order.save();
  } catch (err) {
    order.refundStatus = 'failed';
    order.refundFailReason = err.message || 'Refund request failed';
    await order.save();
  }
}

module.exports = { priceCart, createOrdersFromPricedCart, resolveLinePrice, refundOrderIfNeeded, ALLOWED_TRANSITIONS };
