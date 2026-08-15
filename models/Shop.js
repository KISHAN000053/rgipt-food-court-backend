const mongoose = require('mongoose');

const shopSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  isOpen: { type: Boolean, default: true },
  // Admin can restrict a shop owner from adding/removing items or changing prices,
  // without affecting their ability to toggle stock or fix a typo in a name.
  menuEditingEnabled: { type: Boolean, default: true },
  // Razorpay Route linked account ID (e.g. "acc_xxx"). When set, this shop's
  // share of a payment is transferred to them automatically at checkout. When
  // not set (the default for every shop until deliberately configured), nothing
  // changes — their earnings still show on Payouts and get paid manually, same
  // as every shop has worked until now.
  razorpayLinkedAccountId: { type: String, default: null },
  isPermanentlyClosed: { type: Boolean, default: false },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  ownerEmail: String,
  categories: [String],
}, { timestamps: true });

// ownerEmail is looked up on every shop-owner login and /me request.
shopSchema.index({ ownerEmail: 1 });

module.exports = mongoose.model('Shop', shopSchema);
