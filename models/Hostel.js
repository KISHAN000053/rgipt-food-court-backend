const mongoose = require('mongoose');

const hostelSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  // Fixed room prefix, e.g. "g" for Vidyasagar (rooms are g-xxx), "h" for Homi Bhabha.
  roomPrefix: { type: String, default: '' },
  // How many digits the room number must be. Students can enter only this many.
  roomDigits: { type: Number, default: 3, min: 1, max: 6 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Hostel', hostelSchema);
