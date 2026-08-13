const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { createRazorpayOrder, verifyPaymentSignature, verifyWebhookSignature } = require('../services/razorpayService');

// Given a groupId (a checkout may split into several sub-orders across shops),
// create ONE Razorpay order for the combined total. All sub-orders in the group
// stay 'pending' until payment is confirmed.
router.post('/razorpay/create', requireAuth, asyncHandler(async (req, res) => {
  const { groupId } = req.body;
  if (!groupId) return res.status(400).json({ message: 'groupId is required' });

  const orders = await Order.find({ groupId, user: req.user._id });
  if (orders.length === 0) return res.status(404).json({ message: 'Order group not found' });
  if (orders.some(o => o.paymentStatus === 'paid')) {
    return res.status(400).json({ message: 'This order has already been paid.' });
  }

  const totalRupees = Math.round(orders.reduce((sum, o) => sum + o.total, 0) * 100) / 100;

  let rpOrder;
  try {
    rpOrder = await createRazorpayOrder({ amountRupees: totalRupees, receipt: groupId });
  } catch (err) {
    console.error('[Razorpay create order failed]', {
      groupId,
      amountRupees: totalRupees,
      razorpayError: err?.error || err?.message || err,
    });
    return res.status(502).json({ message: 'Could not start payment. Please try again.' });
  }

  await Order.updateMany({ groupId, user: req.user._id }, { razorpayOrderId: rpOrder.id, paymentMethod: 'razorpay' });

  res.json({
    razorpayOrderId: rpOrder.id,
    amount: rpOrder.amount,
    currency: rpOrder.currency,
    keyId: process.env.RAZORPAY_KEY_ID, // public key — safe to expose
  });
}));

// Called by the frontend right after Razorpay's checkout modal succeeds. This gives
// the student instant confirmation in the UI, but it is NOT the final word — the
// webhook below is what actually marks the order paid for good. If this call is
// skipped or fails, the webhook still confirms payment on its own.
router.post('/razorpay/verify', requireAuth, asyncHandler(async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ message: 'Missing payment verification fields' });
  }

  const valid = verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature });
  if (!valid) {
    return res.status(400).json({ message: 'Payment verification failed.' });
  }

  const orders = await Order.find({ razorpayOrderId, user: req.user._id });
  if (orders.length === 0) return res.status(404).json({ message: 'Order not found' });

  await Order.updateMany(
    { razorpayOrderId, user: req.user._id },
    { paymentStatus: 'paid', razorpayPaymentId }
  );

  const io = req.app.get('io');
  if (io) {
    for (const order of orders) {
      io.to(`shop-${order.shop}`).emit('newOrder', order);
    }
  }

  res.json({ message: 'Payment confirmed' });
}));

// Razorpay webhook — the real source of truth for payment status. Needs the RAW
// request body for signature verification, so this route is mounted with
// express.raw() in server.js rather than the global express.json() parser.
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
    const razorpayOrderId = payment.order_id;

    // Idempotent: only orders not already marked paid get updated (and notified) here,
    // so if /verify already handled it, this doesn't double-notify the shop.
    const newlyPaid = await Order.find({ razorpayOrderId, paymentStatus: { $ne: 'paid' } });

    if (newlyPaid.length > 0) {
      await Order.updateMany(
        { razorpayOrderId, paymentStatus: { $ne: 'paid' } },
        { paymentStatus: 'paid', razorpayPaymentId: payment.id }
      );

      const io = req.app.get('io');
      if (io) {
        for (const order of newlyPaid) {
          io.to(`shop-${order.shop}`).emit('newOrder', order);
        }
      }
    }
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
