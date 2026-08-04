const express = require('express');
const router = express.Router();
const MenuItem = require('../models/MenuItem');
const Settings = require('../models/Settings');
const asyncHandler = require('../middleware/asyncHandler');

// Applies the platform surcharge to a base price and rounds to 2 decimals.
const withMarkup = (basePrice, surchargePercent) => {
  return Math.round(basePrice * (1 + surchargePercent / 100) * 100) / 100;
};

router.get('/shops/:id/menu', asyncHandler(async (req, res) => {
  const settings = await Settings.getGlobal();
  const menuItems = await MenuItem.find({ shop: req.params.id, isEnabled: true });

  const grouped = menuItems.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    const displayItem = item.toObject();
    displayItem.basePrice = item.price;
    displayItem.price = withMarkup(item.price, settings.razorpaySurchargePercent);
    acc[item.category].push(displayItem);
    return acc;
  }, {});

  res.json(grouped);
}));

router.get('/search', asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return res.json([]);
  }

  const settings = await Settings.getGlobal();
  const items = await MenuItem.find({
    $text: { $search: q },
    isEnabled: true
  }).populate('shop', 'name');

  const withPrices = items.map(item => {
    const obj = item.toObject();
    obj.basePrice = item.price;
    obj.price = withMarkup(item.price, settings.razorpaySurchargePercent);
    return obj;
  });

  res.json(withPrices);
}));

module.exports = router;
