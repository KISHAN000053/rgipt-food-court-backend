const mongoose = require('mongoose');

const shopSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  isOpen: { type: Boolean, default: true },
  // Admin can restrict a shop owner from adding/removing items or changing prices,
  // without affecting their ability to toggle stock or fix a typo in a name.
  // Controls when the shop owner can edit their own menu (add/remove items,
  // change prices, names, categories). Marking something in/out of stock is
  // NEVER blocked by this — that's real-time operations, not "editing".
  //   'default'      — only while the shop is offline AND within the 3:30 AM–2:30 PM
  //                    window (prevents changing prices/items mid-service or overnight)
  //   'unrestricted' — no time or online/offline restriction at all
  //   'restricted'   — cannot edit menu structure at all, admin-only
  menuEditPolicy: { type: String, enum: ['default', 'unrestricted', 'restricted'], default: 'default' },
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
