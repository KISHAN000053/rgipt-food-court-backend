const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.patch('/profile', requireAuth, asyncHandler(async (req, res) => {
  const { hostel, roomNumber, phone, agreeToTerms } = req.body;

  if (!req.user.acceptedTerms && !agreeToTerms) {
    return res.status(400).json({ message: 'You must agree to the Terms of Service, Privacy Policy, and Code of Conduct to continue.' });
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
