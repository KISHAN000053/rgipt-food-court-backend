const express = require('express');
const router = express.Router();
const Settings = require('../models/Settings');
const asyncHandler = require('../middleware/asyncHandler');

// Public, read-only. Only exposes the two numbers needed for the pricing disclaimer.
router.get('/public', asyncHandler(async (req, res) => {
  const settings = await Settings.getGlobal();
  res.json({
    razorpaySurchargePercent: settings.razorpaySurchargePercent,
    serviceFee: settings.serviceFee
  });
}));

module.exports = router;
