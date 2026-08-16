const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const PendingCheckout = require('../models/PendingCheckout');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { createRazorpayOrder, verifyPaymentSignature, verifyWebhookSignature, fetchOrderTransfers } = require('../services/razorpayService');
const { priceCart, createOrdersFromPricedCart, getShopSubtotals } = require('../services/orderService');

// Prices the cart and creates a Razorpay order in one step. Nothing is written to the
// orders collection here — only a short-lived PendingCheckout record that expires on
// its own if payment is never completed. The order only gets created for real once
// payment is confirmed, in finalizeCheckout() below.
router.post('/razorpay/create-order', requireAuth, asyncHandler(async (req, res) => {
  const { items, orderType, specialInstructions } = req.body;

  const priced = await priceCart({ user: req.user, items, orderType });
  if (!priced.ok) {
    return res.status(priced.status).json({ message: priced.message });
  }

  // Any shop in this cart with a Razorpay Route linked account configured gets
  // its share transferred automatically the moment payment is captured. Shops
  // without one configured are simply left out here — their share stays in the
  // main account, exactly like every order has worked until now. This makes
  // automatic splitting purely opt-in, per shop, with zero risk to shops that
  // haven't been set up yet.
  const shopSubtotals = getShopSubtotals(priced);
  const transfers = [];
  for (const shopId of priced.shopIds) {
    const shop = priced.shopMap.get(shopId);
    if (shop?.razorpayLinkedAccountId) {
      transfers.push({ account: shop.razorpayLinkedAccountId, amountRupees: shopSubtotals.get(shopId) });
    }
  }

  let rpOrder;
  try {
    rpOrder = await createRazorpayOrder({ amountRupees: priced.totalRupees, receipt: `chk-${req.user._id}-${Date.now()}`, transfers });
  } catch (err) {
    console.error('[Razorpay create order failed]', {
      userId: req.user._id,
      amountRupees: priced.totalRupees,
      razorpayError: err?.error || err?.message || err,
    });
    return res.status(502).json({ message: 'Could not start payment. Please try again.' });
  }

  await PendingCheckout.create({
    user: req.user._id,
    razorpayOrderId: rpOrder.id,
    items,
    orderType,
    specialInstructions,
  });

  res.json({
    razorpayOrderId: rpOrder.id,
    amount: rpOrder.amount,
    currency: rpOrder.currency,
    keyId: process.env.RAZORPAY_KEY_ID, // public key — safe to expose
  });
}));

// The single place an order actually gets created — only ever called once payment is
// confirmed, by whichever of /verify or the webhook gets there first. Safe to call
// twice: if the PendingCheckout is already gone, this is a no-op (idempotent).
async function finalizeCheckout(razorpayOrderId, razorpayPaymentId, io) {
  const pending = await PendingCheckout.findOne({ razorpayOrderId });
  if (!pending) return null; // already finalized by the other path, or never existed

  const priced = await priceCart({ user: pending.user, items: pending.items, orderType: pending.orderType });
  if (!priced.ok) {
    // Extremely unlikely (something changed between payment and finalization, e.g. a
    // shop closed mid-payment) — remove the pending record so it doesn't retry forever,
    // and surface this clearly rather than silently losing a paid transaction.
    console.error('[Checkout finalize failed after payment]', { razorpayOrderId, reason: priced.message });
    await pending.deleteOne();
    return { failed: true, message: priced.message };
  }

  // If any shop in this order had a Route transfer configured, find out which
  // transfer_id actually corresponds to which shop, so each Order document can
  // remember its own — required later for a correct, isolated refund reversal.
  const transfersByShop = new Map();
  const hasAnyLinkedShop = Array.from(priced.shopMap.values()).some(s => s.razorpayLinkedAccountId);
  if (hasAnyLinkedShop) {
    try {
      const realTransfers = await fetchOrderTransfers(razorpayOrderId);
      for (const shopId of priced.shopIds) {
        const shop = priced.shopMap.get(shopId);
        if (!shop?.razorpayLinkedAccountId) continue;
        // 'recipient' is the field Razorpay actually returns — confirmed directly
        // against their own documented example response. It's a plain string:
        // the linked account ID itself, not a nested object.
        const found = realTransfers.find(t => t.recipient === shop.razorpayLinkedAccountId);
        if (found) transfersByShop.set(shopId, { id: found.id });
      }
    } catch (err) {
      // Payment already succeeded — we don't fail the order over this, but a
      // missing transfer_id here means that order can't have its transfer
      // reversed automatically later if it's ever cancelled. Loud, not silent.
      console.error('[Could not fetch Route transfers for order]', { razorpayOrderId, error: err?.message || err });
    }
  }

  const { groupId, orders } = await createOrdersFromPricedCart({
    user: { _id: pending.user },
    priced,
    paymentMethod: 'razorpay',
    razorpayOrderId,
    razorpayPaymentId,
    specialInstructions: pending.specialInstructions,
    io,
    transfersByShop,
  });

  await pending.deleteOne();
  return { groupId, orders };
}

// Called by the frontend right after Razorpay's checkout modal succeeds — gives the
// student instant confirmation. Not the only word on it, though: the webhook below
// independently confirms the same way, so a closed browser or failed callback here
// still results in the order being created correctly.
router.post('/razorpay/verify', requireAuth, asyncHandler(async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ message: 'Missing payment verification fields' });
  }

  const valid = verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature });
  if (!valid) {
    return res.status(400).json({ message: 'Payment verification failed.' });
  }

  const result = await finalizeCheckout(razorpayOrderId, razorpayPaymentId, req.app.get('io'));

  if (result?.failed) {
    return res.status(409).json({ message: result.message });
  }
  if (!result) {
    // Already finalized (likely the webhook beat us to it) — confirm using the real order.
    const existing = await Order.findOne({ razorpayOrderId });
    if (existing) return res.json({ message: 'Payment confirmed', groupId: existing.groupId });
    return res.status(404).json({ message: 'Order not found' });
  }

  res.json({ message: 'Payment confirmed', groupId: result.groupId });
}));

// Razorpay webhook — the real source of truth for payment status, and the fallback
// that finalizes the order even if the student's browser closes right after paying.
// Needs the RAW request body for signature verification, so this route is mounted
// with express.raw() in server.js rather than the global express.json() parser.
router.post('/razorpay/webhook', asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  let valid;
  try {
    valid = verifyWebhookSignature({ rawBody: req.body, signature });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
  if (!valid) {
    return res.status(400).json({ message: 'Invalid webhook signature' });
  }

  const event = JSON.parse(req.body.toString());

  if (event.event === 'payment.captured') {
    const payment = event.payload.payment.entity;
    await finalizeCheckout(payment.order_id, payment.id, req.app.get('io'));
  }

  // Confirms a refund actually completed (or failed) on Razorpay's side — this is
  // the real source of truth, same principle as payment.captured above. We initiate
  // refunds ourselves and mark them 'processing'; this webhook is what finalizes it.
  if (event.event === 'refund.processed' || event.event === 'refund.failed') {
    const refund = event.payload.refund.entity;
    const order = await Order.findOne({ refundId: refund.id });

    if (order) {
      order.refundStatus = event.event === 'refund.processed' ? 'completed' : 'failed';
      if (event.event === 'refund.processed') order.refundedAt = new Date();
      await order.save();

      const io = req.app.get('io');
      if (io) io.to(`user-${order.user}`).emit('orderStatusChanged', order);
    }
  }

  // Always 200 quickly so Razorpay doesn't retry unnecessarily.
  res.json({ received: true });
}));

module.exports = router;
