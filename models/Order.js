const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true },
  groupId: { type: String, index: true }, // shared by all shop sub-orders placed in a single checkout
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  items: [{
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
    name: String,
    price: Number,
    basePrice: Number,
    quantity: Number
  }],
  subtotal: Number,
  serviceFee: { type: Number, default: 2 },
  total: Number,
  orderType: { type: String, enum: ['takeaway', 'hostel'], default: 'hostel' },
  status: { 
    type: String, 
    enum: ['pending', 'accepted', 'preparing', 'delivery_initiated', 'cancelled'], 
    default: 'pending' 
  },
  paymentMethod: { type: String, enum: ['cash', 'upi'], default: 'cash' },
  paymentStatus: { type: String, enum: ['pending', 'paid'], default: 'pending' },
  specialInstructions: String,
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
