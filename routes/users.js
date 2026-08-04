const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.patch('/profile', requireAuth, asyncHandler(async (req, res) => {
  const { hostel, roomNumber, phone } = req.body;
  const user = await User.findByIdAndUpdate(
    req.user._id,
    { hostel, roomNumber, phone, isOnboarded: true },
    { new: true, runValidators: true }
  );
  res.json(user);
}));

module.exports = router;
