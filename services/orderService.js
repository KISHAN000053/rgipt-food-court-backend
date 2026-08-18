const crypto = require('crypto');
const Order = require('../models/Order');
const MenuItem = require('../models/MenuItem');
const Shop = require('../models/Shop');
const Settings = require('../models/Settings');

// pending -> accepted -> [preparing] -> delivery_initiated -> completed.
// delivery_initiated means "ready for pickup" (takeaway) or "out for delivery"
// (hostel). completed means the food actually reached the student — for
// takeaway this requires the pickup PIN; for hostel it doesn't, since there's
// no equivalent "wrong person picked it up" risk. Cancelled is allowed from any
// non-terminal state. Shared between the shop-owner and admin order-status
// routes so the rules can never drift between them.
const ALLOWED_TRANSITIONS = {
  pending: ['accepted', 'cancelled'],
  accepted: ['preparing', 'delivery_initiated', 'cancelled'],
  preparing: ['delivery_initiated', 'cancelled'],
  delivery_initiated: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

// Checks both the normal state-machine rules AND, specifically for a takeaway
// order being marked completed, that the correct pickup PIN was provided.
// Centralized here so the shop-owner and admin status routes can never
// silently drift into different rules for the same thing.
function validateStatusTransition({ order, newStatus, providedPin }) {
  const allowed = ALLOWED_TRANSITIONS[order.status] || [];
  if (!allowed.includes(newStatus)) {
    return { ok: false, message: `Cannot move an order from "${order.status}" to "${newStatus}".` };
  }
  if (newStatus === 'completed' && order.orderType === 'takeaway' && order.pickupPin) {
    if (!providedPin || String(providedPin).trim() !== order.pickupPin) {
      return { ok: false, message: 'Incorrect pickup PIN. Ask the student for their code before completing this order.' };
    }
  }
  return { ok: true };
}

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
    shopMap, // shopId -> Shop doc — used to look up razorpayLinkedAccountId for Route transfers
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
// Per-shop subtotal from an already-priced cart. Used to build Route transfer
// instructions at checkout time (before payment) — kept as its own function so
// this exact number is never computed two different ways in two different places.
function getShopSubtotals(priced) {
  const result = new Map();
  for (const shopId of priced.shopIds) {
    const lines = priced.byShop.get(shopId);
    const subtotal = Math.round(lines.reduce((s, { price, quantity }) => s + price * quantity, 0) * 100) / 100;
    result.set(shopId, subtotal);
  }
  return result;
}

async function createOrdersFromPricedCart({ user, priced, paymentMethod, razorpayOrderId, razorpayPaymentId, specialInstructions, io, transfersByShop }) {
  const { type, byShop, shopIds, serviceFee, processingFeeTotal } = priced;
  const groupId = 'GRP-' + crypto.randomBytes(6).toString('hex');
  const createdOrders = [];

  // Last 4 digits of the student's own phone number — they already know this
  // without needing to look anything up. Falls back to a timestamp-derived code
  // only if a phone number is somehow missing or malformed (shouldn't happen —
  // onboarding requires it — but checkout should never crash over this).
  const pickupPin = type === 'takeaway'
    ? (/^[0-9]{10}$/.test(user.phone || '') ? user.phone.slice(-4) : String(Date.now()).slice(-4))
    : undefined;

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

    // If this shop's share was automatically transferred via Route, remember
    // exactly which transfer — required later so a cancellation reverses only
    // this specific transfer, never anything belonging to another shop.
    const transfer = transfersByShop?.get(shopId);

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
      routeTransferId: transfer?.id,
      routeTransferAmount: transfer ? subtotal : undefined,
      pickupPin,
    });

    createdOrders.push(order);

    if (io) {
      io.to(`shop-${shopId}`).emit('newOrder', order);
    }

    // Push notification to the shop owner — fires in background even when the
    // app isn't the active tab. Does NOT throw on failure so a push problem
    // can never block the order from being created.
    try {
      const shop = await Shop.findById(shopId).select('ownerId');
      if (shop?.ownerId) {
        const { notifyUser } = require('./pushService');
        const itemSummary = order.items.slice(0, 2).map(i => `${i.quantity}x ${i.name}`).join(', ');
        const more = order.items.length > 2 ? ` +${order.items.length - 2} more` : '';
        await notifyUser(shop.ownerId, {
          title: `New order — ₹${order.total}`,
          body: itemSummary + more,
          orderId: String(order._id),
          tag: `new-order-${order._id}`, // prevents duplicate notifications for same order
          requireInteraction: true,      // keeps notification visible until dismissed
        });
      }
    } catch (err) {
      console.error('[Push notification error on new order]', err?.message || err);
    }
  } // end of for loop over shopIds

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

  const { createRefund, reverseTransfer } = require('./razorpayService');

  // If this order's share was auto-transferred to the shop via Route, that
  // money must be pulled back FIRST — otherwise refunding the student would
  // come out of the main account while the shop still holds their share,
  // leaving the platform short by exactly that amount. This step can fail
  // (most likely if the shop already withdrew/settled that money out) — if it
  // does, we do NOT proceed to refund the student, and mark this loudly for
  // manual follow-up rather than quietly creating a financial hole.
  if (order.routeTransferId && !order.routeTransferReversed) {
    try {
      await reverseTransfer({ transferId: order.routeTransferId, amountRupees: order.routeTransferAmount || order.subtotal });
      order.routeTransferReversed = true;
      await order.save();
    } catch (err) {
      order.refundStatus = 'failed';
      order.refundFailReason = `Could not reclaim funds from shop's account before refunding: ${err.message || 'reversal failed'}. This needs manual attention — the shop may already have withdrawn this amount.`;
      await order.save();
      return; // deliberately stop here — do not refund the student on an unreconciled order
    }
  }

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

module.exports = { priceCart, createOrdersFromPricedCart, getShopSubtotals, resolveLinePrice, refundOrderIfNeeded, validateStatusTransition, ALLOWED_TRANSITIONS };
