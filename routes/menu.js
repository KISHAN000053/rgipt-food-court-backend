const express = require('express');
const router = express.Router();
const MenuItem = require('../models/MenuItem');
const asyncHandler = require('../middleware/asyncHandler');

router.get('/shops/:id/menu', asyncHandler(async (req, res) => {
  const menuItems = await MenuItem.find({ shop: req.params.id, isEnabled: true, isAddon: { $ne: true } });
  const grouped = menuItems.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {});
  res.json(grouped);
}));

// Add-ons for a shop — simple extras (Egg, Cheese, etc.) shown through a separate
// picker rather than the regular categorized menu.
router.get('/shops/:id/addons', asyncHandler(async (req, res) => {
  const addons = await MenuItem.find({ shop: req.params.id, isEnabled: true, isAvailable: true, isAddon: true });
  res.json(addons);
}));

module.exports = router;
