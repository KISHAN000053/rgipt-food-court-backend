const express = require('express');
const router = express.Router();
const Shop = require('../models/Shop');
const asyncHandler = require('../middleware/asyncHandler');

router.get('/', asyncHandler(async (req, res) => {
  const shops = await Shop.find({ isPermanentlyClosed: false });
  res.json(shops);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const shop = await Shop.findOne({ _id: req.params.id, isPermanentlyClosed: false });
  if (!shop) {
    return res.status(404).json({ message: 'Shop not found' });
  }
  res.json(shop);
}));

module.exports = router;
