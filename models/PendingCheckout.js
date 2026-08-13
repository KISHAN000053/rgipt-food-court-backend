const mongoose = require('mongoose');

// This is NOT an order — it's a temporary holding record for a checkout attempt
// that's mid-payment. It exists only so the server remembers what the student was
// trying to buy between "Razorpay order created" and "payment confirmed". If payment
// is abandoned, failed, or the browser is closed, this record simply expires on its
// own (TTL index below) — nothing about it ever appears in the orders collection,
// on the shop dashboard, or in admin views.
const pendingCheckoutSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  razorpayOrderId: { type: String, required: true, unique: true },
  items: { type: Array, required: true }, // raw cart lines as submitted
  orderType: String,
  specialInstructions: String,
  createdAt: { type: Date, default: Date.now, expires: 1800 }, // auto-deleted after 30 minutes
});

module.exports = mongoose.model('PendingCheckout', pendingCheckoutSchema);
