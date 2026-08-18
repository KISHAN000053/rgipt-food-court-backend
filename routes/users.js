const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Hostel = require('../models/Hostel');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.patch('/profile', requireAuth, asyncHandler(async (req, res) => {
  const { hostel, roomNumber, phone, isJunior, agreeToTerms } = req.body;

  if (!req.user.acceptedTerms && !agreeToTerms) {
    return res.status(400).json({ message: 'You must agree to the Terms of Service, Privacy Policy, and Code of Conduct to continue.' });
  }

  if (!phone) {
    return res.status(400).json({ message: 'Phone number is required.' });
  }
  if (!/^[0-9]{10}$/.test(String(phone))) {
    return res.status(400).json({ message: 'Enter a valid 10-digit mobile number.' });
  }

  const juniorStatus = isJunior !== undefined ? !!isJunior : req.user.isJunior;

  const update = { phone, isJunior: juniorStatus, isOnboarded: true };

  if (juniorStatus) {
    if (!hostel || !roomNumber) {
      return res.status(400).json({ message: 'Hostel and room number are required.' });
    }
    const hostelDoc = await Hostel.findOne({ name: hostel, isActive: true });
    if (!hostelDoc) {
      return res.status(400).json({ message: 'Please select a valid hostel.' });
    }
    if (!/^[0-9]{3,4}$/.test(String(roomNumber).replace(/^.*?-/, ''))) {
      return res.status(400).json({ message: 'Room number must be 3 or 4 digits.' });
    }
    update.hostel = hostel;
    update.roomNumber = roomNumber;
  }

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

// A dedicated, minimal acceptance route — used by shop owners (and admins, if
// ever needed) who don't go through student onboarding at all, and so would
// otherwise never be asked to accept anything. Deliberately doesn't touch
// phone/hostel/isJunior — those are student-only concepts.
router.patch('/accept-terms', requireAuth, asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.user._id,
    { acceptedTerms: true, acceptedTermsAt: new Date() },
    { new: true }
  );
  res.json(user);
}));

module.exports = router;
