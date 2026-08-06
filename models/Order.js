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
    quantity: Number,
    addedByName: String, // for party orders: who in the group asked for this item
  }],
  subtotal: Number,
  serviceFee: { type: Number, default: 2 },
  processingFee: { type: Number, default: 0 },
  total: Number,
  orderType: { type: String, enum: ['takeaway', 'hostel'], default: 'hostel' },
  status: { 
    type: String, 
    enum: ['pending', 'accepted', 'preparing', 'delivery_initiated', 'cancelled'], 
    default: 'pending' 
  },
  paymentMethod: { type: String, enum: ['cash', 'upi', 'razorpay'], default: 'cash' },
  paymentStatus: { type: String, enum: ['pending', 'paid'], default: 'pending' },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  specialInstructions: String,
  partyCode: String, // set when this order came from a party room
}, { timestamps: true });

// Indexes for the queries that actually run often, so they don't scan the whole collection:
orderSchema.index({ user: 1, createdAt: -1 });   // student's order history
orderSchema.index({ shop: 1, status: 1 });        // shop owner's live/pending orders

module.exports = mongoose.model('Order', orderSchema);
