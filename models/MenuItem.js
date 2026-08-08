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
  // Add-ons (e.g. Egg, Cheese, Chicken) are simple extras a student can add alongside
  // whatever's already in their cart from this shop. Always single-price, and shown
  // through a separate "Add-ons" picker rather than the regular category menu.
  isAddon: { type: Boolean, default: false },
}, { timestamps: true });

menuItemSchema.index({ name: 'text', description: 'text', category: 'text' });

module.exports = mongoose.model('MenuItem', menuItemSchema);
