const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Hostel = require('../models/Hostel');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.patch('/profile', requireAuth, asyncHandler(async (req, res) => {
  const { hostel, roomNumber, phone, agreeToTerms } = req.body;

  if (!req.user.acceptedTerms && !agreeToTerms) {
    return res.status(400).json({ message: 'You must agree to the Terms of Service, Privacy Policy, and Code of Conduct to continue.' });
  }

  if (!hostel || !roomNumber || !phone) {
    return res.status(400).json({ message: 'Hostel, room number and phone are required.' });
  }

  if (!/^[0-9]{10}$/.test(String(phone))) {
    return res.status(400).json({ message: 'Enter a valid 10-digit mobile number.' });
  }

  // Validate the room number digits against the selected hostel's rule.
  const hostelDoc = await Hostel.findOne({ name: hostel, isActive: true });
  if (!hostelDoc) {
    return res.status(400).json({ message: 'Please select a valid hostel.' });
  }
  if (!new RegExp(`^[0-9]{${hostelDoc.roomDigits}}$`).test(String(roomNumber))) {
    return res.status(400).json({ message: `Room number must be exactly ${hostelDoc.roomDigits} digits for ${hostel}.` });
  }

  const update = { hostel, roomNumber, phone, isOnboarded: true };
  if (!req.user.acceptedTerms) {
    update.acceptedTerms = true;
    update.acceptedTermsAt = new Date();
  }

  const user = await User.findByIdAndUpdate(
    req.user._id,
    update,
    { new: true, runValidators: true }
  );
  res.json(user);
}));

module.exports = router;
