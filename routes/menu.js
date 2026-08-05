const express = require('express');
const router = express.Router();
const MenuItem = require('../models/MenuItem');
const asyncHandler = require('../middleware/asyncHandler');

router.get('/shops/:id/menu', asyncHandler(async (req, res) => {
  const menuItems = await MenuItem.find({ shop: req.params.id, isEnabled: true });
  const grouped = menuItems.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {});
  res.json(grouped);
}));

router.get('/search', asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const items = await MenuItem.find({ $text: { $search: q }, isEnabled: true }).populate('shop', 'name');
  res.json(items);
}));

module.exports = router;
