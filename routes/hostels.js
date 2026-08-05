const express = require('express');
const router = express.Router();
const Hostel = require('../models/Hostel');
const asyncHandler = require('../middleware/asyncHandler');

// Public — onboarding needs this before the user has finished setup.
router.get('/', asyncHandler(async (req, res) => {
  const hostels = await Hostel.find({ isActive: true }).sort({ name: 1 });
  res.json(hostels);
}));

module.exports = router;
