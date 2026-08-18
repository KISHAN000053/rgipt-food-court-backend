const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const User = require('../models/User');
const PendingCheckout = require('../models/PendingCheckout');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { createRazorpayOrder, verifyPaymentSignature, verifyWebhookSignature, fetchOrderTransfers, reverseTransfer, createRefund, fetchPayment } = require('../services/razorpayService');
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

  // pending.user is just an ObjectId reference — priceCart needs the real profile
  // (hostel, room, isJunior, phone) to validate correctly. Passing the bare ID
  // through here was silently breaking every hostel-delivery order: the missing
  // .hostel/.roomNumber on a raw ObjectId made the hostel check fail every time,
  // even for students who had those fields set correctly.
  const user = await User.findById(pending.user);
  if (!user) {
    console.error('[Checkout finalize failed after payment]', { razorpayOrderId, reason: 'User not found' });
    await pending.deleteOne();
    return { failed: true, message: 'Your account could not be found.' };
  }

  const priced = await priceCart({ user, items: pending.items, orderType: pending.orderType });
  if (!priced.ok) {
    // Payment already succeeded — money is sitting captured with no order to show
    // for it (most likely cause: a shop in the cart went offline while the student
    // was mid-payment in their UPI app). The only acceptable outcome here is a full
    // refund. Never leave a captured payment with no order and no refund.
    console.error('[Checkout finalize failed after payment — issuing full refund]', { razorpayOrderId, reason: priced.message });
    try {
      // If any linked shop's transfer already fired (Route transfers execute the
      // instant payment is captured, before this code even runs), pull it back
      // first — otherwise the refund would come out of the main account while a
      // shop that never even got a real order keeps their share.
      const existingTransfers = await fetchOrderTransfers(razorpayOrderId).catch(() => []);
      for (const t of existingTransfers) {
        await reverseTransfer({ transferId: t.id, amountRupees: t.amount / 100 }).catch(err =>
          console.error('[Could not reverse stray transfer during failed-finalization refund]', t.id, err?.message)
        );
      }

      const payment = await fetchPayment(razorpayPaymentId);
      await createRefund({
        paymentId: razorpayPaymentId,
        amountRupees: payment.amount / 100,
        notes: { reason: 'Order could not be created after payment — full refund', razorpayOrderId },
      });
      await pending.deleteOne();
      return { failed: true, message: `${priced.message} Your payment has been fully refunded — it should reflect within a few days.` };
    } catch (refundErr) {
      // The one truly serious case: payment captured, order impossible, AND the
      // automatic refund itself failed. This must never disappear silently.
      console.error('[CRITICAL: could not auto-refund a failed finalization]', { razorpayOrderId, razorpayPaymentId, error: refundErr?.message || refundErr });
      await pending.deleteOne();
      return { failed: true, message: `${priced.message} We could not process your refund automatically — please contact Support with this reference: ${razorpayOrderId}` };
    }
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
    user,
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

      if (event.event === 'refund.processed') {
        const { notifyUser } = require('../services/pushService');
        notifyUser(order.user, {
          title: 'RGIPT Food Court',
          body: `Your refund of ₹${order.refundAmount} has been processed.`,
          orderId: String(order._id),
          url: `/orders/${order._id}`,
          tag: `refund-${order._id}`,
        }).catch(err => console.error('[Push notification error on refund]', err?.message || err));
      }
    }
  }

  // Always 200 quickly so Razorpay doesn't retry unnecessarily.
  res.json({ received: true });
}));

module.exports = router;
