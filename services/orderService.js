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
 * Places an order from a list of cart lines, splitting per shop but charging the
 * service fee and processing fee only once for the whole checkout.
 *
 * Used by both normal checkout and party-room checkout so the money logic can never
 * drift between the two.
 *
 * @param {Object} opts
 * @param {Object} opts.user          - the paying user (host, for party orders)
 * @param {Array}  opts.items         - [{ menuItemId, quantity, variantId?, addedByName? }]
 * @param {String} opts.orderType     - 'takeaway' | 'hostel'
 * @param {String} opts.paymentMethod
 * @param {String} opts.specialInstructions
 * @param {Object} opts.io            - socket.io instance (optional)
 * @param {String} opts.partyCode     - set for party orders (optional)
 * @returns {Promise<{ok: true, groupId, orders} | {ok: false, status, message}>}
 */
async function placeOrder({ user, items, orderType, paymentMethod, specialInstructions, io, partyCode }) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, status: 400, message: 'Cart is empty' };
  }

  const type = orderType === 'takeaway' ? 'takeaway' : 'hostel';

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
      addedByName: cartItem.addedByName,
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

  const groupId = 'GRP-' + crypto.randomBytes(6).toString('hex');
  const createdOrders = [];

  for (let i = 0; i < shopIds.length; i++) {
    const shopId = shopIds[i];
    const cartLines = byShop.get(shopId);

    let subtotal = 0;
    const orderItems = cartLines.map(({ menuItem, quantity, addedByName, forProductName, price, variantName }) => {
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
        addedByName: addedByName || undefined,
      };
    });
    subtotal = Math.round(subtotal * 100) / 100;

    const serviceFee = i === 0 ? settings.serviceFee : 0;
    const processingFee = i === 0 ? processingFeeTotal : 0;
    const total = Math.round((subtotal + serviceFee + processingFee) * 100) / 100;
    const orderNumber = 'ORD-' + String(Date.now() % 1000000).padStart(6, '0') + '-' + i;

    const order = await Order.create({
      orderNumber,
      groupId,
      user: user._id,
      shop: shopId,
      items: orderItems,
      orderType: type,
      subtotal,
      serviceFee,
      processingFee,
      total,
      paymentMethod: paymentMethod || 'razorpay',
      specialInstructions,
      partyCode: partyCode || undefined,
    });

    createdOrders.push(order);

    // Cash orders are "confirmed" the moment they're placed. Razorpay orders are not —
    // the shop shouldn't see (or start preparing) an order nobody has paid for yet.
    // The payments routes emit 'newOrder' themselves once payment is actually verified.
    if (io && paymentMethod !== 'razorpay') {
      io.to(`shop-${shopId}`).emit('newOrder', order);
    }
  }

  return { ok: true, groupId, orders: createdOrders };
}

/**
 * Refunds the subtotal of a paid order (keeps service + processing fees) when it's
 * cancelled. Called automatically from the status-change route — never blocks the
 * cancellation itself. If the refund call fails, the order stays cancelled and is
 * marked refundStatus: 'failed' so it's visible, not silently lost.
 */
async function refundOrderIfNeeded(order) {
  // Nothing to refund — never paid, or already handled.
  if (order.paymentMethod !== 'razorpay' || order.paymentStatus !== 'paid') return;
  if (order.refundStatus === 'processing' || order.refundStatus === 'completed') return;
  if (!order.razorpayPaymentId || !order.subtotal || order.subtotal <= 0) return;

  const { createRefund } = require('./razorpayService'); // lazy require avoids a circular import

  try {
    const refund = await createRefund({
      paymentId: order.razorpayPaymentId,
      amountRupees: order.subtotal,
      notes: { orderId: String(order._id), reason: 'Order cancelled — food price refunded, fees kept' },
    });
    order.refundStatus = 'processing'; // confirmed 'completed' once the refund.processed webhook arrives
    order.refundId = refund.id;
    order.refundAmount = order.subtotal;
    await order.save();
  } catch (err) {
    order.refundStatus = 'failed';
    order.refundFailReason = err.message || 'Refund request failed';
    await order.save();
  }
}

module.exports = { placeOrder, resolveLinePrice, refundOrderIfNeeded, ALLOWED_TRANSITIONS };
