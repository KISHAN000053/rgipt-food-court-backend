const crypto = require('crypto');
const Razorpay = require('razorpay');

// Reads keys from environment variables only. Never hardcode keys here —
// set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in your hosting provider's
// environment variable settings (e.g. Render → your service → Environment).
let razorpayClient = null;
function getClient() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay is not configured: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing.');
  }
  if (!razorpayClient) {
    razorpayClient = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayClient;
}

// Creates a Razorpay order for the given amount (in rupees). Amount is converted
// to paise as Razorpay requires. receipt should be something you can trace back
// to your own order group (we use the groupId).
async function createRazorpayOrder({ amountRupees, receipt }) {
  const client = getClient();
  const order = await client.orders.create({
    amount: Math.round(amountRupees * 100), // paise
    currency: 'INR',
    receipt,
  });
  return order; // { id, amount, currency, ... }
}

// Verifies the signature Razorpay sends back after checkout. This confirms the
// payment response actually came from Razorpay and wasn't forged client-side.
function verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  if (!process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay is not configured: RAZORPAY_KEY_SECRET missing.');
  }
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  return expected === razorpaySignature;
}

// Verifies a webhook payload's signature using the separate webhook secret
// (set in Razorpay Dashboard → Settings → Webhooks, and as RAZORPAY_WEBHOOK_SECRET
// in your environment variables). This is the source of truth for "was this
// actually paid" — never trust the frontend alone for that.
function verifyWebhookSignature({ rawBody, signature }) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    throw new Error('Razorpay webhook is not configured: RAZORPAY_WEBHOOK_SECRET missing.');
  }
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return expected === signature;
}

// Refunds part of a captured payment (used when a paid order is cancelled — we
// refund only the subtotal, keeping the service and processing fees).
// notes.reason helps identify refunds later in the Razorpay dashboard.
async function createRefund({ paymentId, amountRupees, notes }) {
  const client = getClient();
  const refund = await client.payments.refund(paymentId, {
    amount: Math.round(amountRupees * 100), // paise
    notes,
  });
  return refund; // { id, status, ... }
}

module.exports = { createRazorpayOrder, verifyPaymentSignature, verifyWebhookSignature, createRefund };
