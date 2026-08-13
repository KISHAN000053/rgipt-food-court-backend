const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  avatar: String,
  hostel: String,
  roomNumber: String,
  isJunior: { type: Boolean, default: null },
  phone: String,
  isOnboarded: { type: Boolean, default: false },
  acceptedTerms: { type: Boolean, default: false },
  acceptedTermsAt: Date,
  role: { type: String, enum: ['student', 'admin'], default: 'student' },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
