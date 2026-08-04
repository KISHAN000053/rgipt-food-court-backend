const mongoose = require('mongoose');

const menuItemSchema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  category: { type: String, required: true },
  isVeg: { type: Boolean, default: true },
  description: String,
  isAvailable: { type: Boolean, default: true },
  isEnabled: { type: Boolean, default: true },
  needsVerification: { type: Boolean, default: false },
}, { timestamps: true });

menuItemSchema.index({ name: 'text', description: 'text', category: 'text' });

module.exports = mongoose.model('MenuItem', menuItemSchema);
