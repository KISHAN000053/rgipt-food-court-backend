const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  items: [{
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
    name: String,
    price: Number,
    quantity: Number
  }],
  subtotal: Number,
  serviceFee: { type: Number, default: 2 },
  total: Number,
  status: { 
    type: String, 
    enum: ['pending', 'accepted', 'preparing', 'ready', 'delivered', 'cancelled'], 
    default: 'pending' 
  },
  paymentMethod: { type: String, enum: ['cash', 'upi'], default: 'cash' },
  paymentStatus: { type: String, enum: ['pending', 'paid'], default: 'pending' },
  specialInstructions: String,
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
