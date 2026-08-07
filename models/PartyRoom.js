const mongoose = require('mongoose');

const partyRoomSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: 'Party Order' },
  host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  items: [{
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
    name: String,
    variantId: mongoose.Schema.Types.ObjectId, // set if the item had multiple price options
    variantName: String,
    price: Number,
    shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' },
    shopName: String,
    quantity: { type: Number, default: 1 },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    addedByName: String,
  }],
  // 'open' = guests can still add; 'ordered' = host has paid, room is locked.
  status: { type: String, enum: ['open', 'ordered', 'cancelled'], default: 'open' },
  orderGroupId: String, // set once the host places the order
}, { timestamps: true });

module.exports = mongoose.model('PartyRoom', partyRoomSchema);
