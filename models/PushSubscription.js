const mongoose = require('mongoose');

// Stores the browser's push subscription object for a specific user.
// A single user can have multiple entries — one per browser/device they've
// subscribed on. Old/invalid subscriptions are removed automatically when
// web-push reports a 410 (subscription no longer valid).
const pushSubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  subscription: { type: Object, required: true }, // { endpoint, keys: { p256dh, auth } }
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
