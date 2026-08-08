require('dotenv').config();
const mongoose = require('mongoose');
const Shop = require('../models/Shop');
const MenuItem = require('../models/MenuItem');

// Run once: node scripts/seedShop5Addons.js
// Safe to run again — it skips any add-on that already exists by name for this shop.
const ADDONS = [
  { name: 'Egg', price: 10 },
  { name: 'Liquid Cheese', price: 15 },
  { name: 'Chicken', price: 30 },
  { name: 'Paneer', price: 30 },
];

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    // Matches "Shop 5(witcher burrito)" regardless of exact spacing/case.
    const shop = await Shop.findOne({ name: /witcher burrito/i });
    if (!shop) {
      console.log('Could not find a shop matching "witcher burrito" — no changes made. Check the shop name and edit this script if needed.');
      process.exit(1);
    }

    let created = 0;
    for (const addon of ADDONS) {
      const exists = await MenuItem.findOne({ shop: shop._id, name: addon.name, isAddon: true });
      if (exists) continue;
      await MenuItem.create({
        shop: shop._id,
        name: addon.name,
        price: addon.price,
        category: 'Add-ons',
        isAddon: true,
        isVeg: addon.name !== 'Egg' && addon.name !== 'Chicken',
      });
      created++;
    }

    console.log(`Done. Created ${created} new add-on(s) for "${shop.name}" (existing ones left untouched).`);
    process.exit(0);
  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  }
}

seed();
