const mongoose = require('mongoose');

const variantSchema = new mongoose.Schema({
  name: { type: String, default: '' }, // e.g. "Quarter", "Half", "Full" — optional
  price: { type: Number, required: true },
});

const menuItemSchema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  name: { type: String, required: true },
  // Used when hasVariants is false — the item's single price. When hasVariants is
  // true, this is ignored in favor of the variants array below.
  price: { type: Number, required: true },
  hasVariants: { type: Boolean, default: false },
  variants: [variantSchema], // e.g. Quarter ₹80, Half ₹150, Full ₹280 — any item, any options
  category: { type: String, required: true },
  isVeg: { type: Boolean, default: true },
  description: String,
  isAvailable: { type: Boolean, default: true },
  isEnabled: { type: Boolean, default: true },
  needsVerification: { type: Boolean, default: false },
}, { timestamps: true });

menuItemSchema.index({ name: 'text', description: 'text', category: 'text' });

module.exports = mongoose.model('MenuItem', menuItemSchema);
