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
//
// transfers (optional): [{ account: 'acc_xxx', amountRupees: N }, ...] — one entry
// per shop that has a Razorpay Route linked account configured. Any shop NOT
// included here simply keeps its share in the main account, exactly like the
// manual-payout flow that's been running until now — this makes automatic
// splitting purely opt-in, per shop, with zero effect on unlinked shops.
async function createRazorpayOrder({ amountRupees, receipt, transfers }) {
  const client = getClient();
  const payload = {
    amount: Math.round(amountRupees * 100), // paise
    currency: 'INR',
    receipt,
  };
  if (transfers && transfers.length > 0) {
    payload.transfers = transfers.map(t => ({
      account: t.account,
      amount: Math.round(t.amountRupees * 100),
      currency: 'INR', // required on EACH transfer entry — the order's own currency field doesn't cover this
      on_hold: 0,
    }));
  }
  const order = await client.orders.create(payload);
  return order; // { id, amount, currency, ... }
}

// After payment is captured, this is how we find out which transfer went to
// which linked account — needed so each Order document can remember its own
// transfer_id (required later if that specific order needs to be refunded).
//
// Uses the documented expand parameter rather than an unverified convenience
// method, since this is the shape confirmed directly in Razorpay's own examples:
// the order response gets a nested transfers.items array, and each transfer's
// destination account is in a field called "recipient" (a plain string).
async function fetchOrderTransfers(razorpayOrderId) {
  const client = getClient();
  const order = await client.orders.fetch(razorpayOrderId, { expand: ['transfers'] });
  return order.transfers?.items || [];
}

// Pulls a shop's money back from their linked account into the main account —
// the necessary first step before refunding a customer on an order that was
// already auto-transferred. Without this, refunding the customer would come
// straight out of the main account while the shop still has their share,
// leaving the platform short by exactly that amount.
//
// This CAN fail — most commonly if the shop has already withdrawn/settled that
// money out of their linked account balance. That failure must never be
// swallowed silently (see refundOrderIfNeeded in orderService.js).
async function reverseTransfer({ transferId, amountRupees }) {
  const client = getClient();
  const reversal = await client.transfers.reverse(transferId, {
    amount: Math.round(amountRupees * 100),
  });
  return reversal; // { id, amount, ... }
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

module.exports = { createRazorpayOrder, verifyPaymentSignature, verifyWebhookSignature, createRefund, fetchOrderTransfers, reverseTransfer };
