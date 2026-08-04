const mongoose = require('mongoose');

const shopSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  isOpen: { type: Boolean, default: true },
  isPermanentlyClosed: { type: Boolean, default: false },
  estimatedPrepTime: Number,
  minOrder: Number,
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  ownerEmail: String,
  categories: [String],
}, { timestamps: true });

module.exports = mongoose.model('Shop', shopSchema);
