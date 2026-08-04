require('dotenv').config();
const mongoose = require('mongoose');
const Shop = require('../models/Shop');
const MenuItem = require('../models/MenuItem');

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/rgipt-food-court');
    console.log('Connected to DB');

    await Shop.deleteMany({});
    await MenuItem.deleteMany({});

    const shopsData = [
      { name: "Main Canteen", isOpen: true, estimatedPrepTime: 15, minOrder: 30, categories: ['Biryani', 'Thali', 'Roti', 'Dal', 'Rice', 'Drinks'] },
      { name: "Fast Bites", isOpen: true, estimatedPrepTime: 10, minOrder: 20, categories: ['Burger', 'Sandwich', 'Momos', 'Rolls', 'Fries'] },
      { name: "Chinese Corner", isOpen: true, estimatedPrepTime: 12, minOrder: 40, categories: ['Chinese', 'Noodles', 'Rice', 'Soup'] },
      { name: "Juice Bar", isOpen: false, isPermanentlyClosed: true, estimatedPrepTime: 5, minOrder: 20, categories: ['Juice', 'Shakes'] },
      { name: "Brew Point", isOpen: true, estimatedPrepTime: 8, minOrder: 15, categories: ['Coffee', 'Tea', 'Shakes', 'Juices', 'Snacks'] }
    ];

    const shops = await Shop.insertMany(shopsData);
    
    const menuData = [
      // Main Canteen
      { shop: shops[0]._id, name: 'Veg Biryani', price: 80, category: 'Biryani', isVeg: true },
      { shop: shops[0]._id, name: 'Chicken Biryani', price: 110, category: 'Biryani', isVeg: false },
      { shop: shops[0]._id, name: 'Egg Biryani', price: 90, category: 'Biryani', isVeg: false },
      { shop: shops[0]._id, name: 'Veg Thali', price: 70, category: 'Thali', isVeg: true },
      { shop: shops[0]._id, name: 'Dal Chawal', price: 50, category: 'Rice', isVeg: true },
      { shop: shops[0]._id, name: 'Paneer Curry', price: 80, category: 'Thali', isVeg: true },
      { shop: shops[0]._id, name: 'Roti (2 pcs)', price: 15, category: 'Roti', isVeg: true },
      { shop: shops[0]._id, name: 'Lassi', price: 30, category: 'Drinks', isVeg: true },
      { shop: shops[0]._id, name: 'Cold Drink', price: 30, category: 'Drinks', isVeg: true },

      // Fast Bites
      { shop: shops[1]._id, name: 'Veg Burger', price: 60, category: 'Burger', isVeg: true },
      { shop: shops[1]._id, name: 'Chicken Burger', price: 80, category: 'Burger', isVeg: false },
      { shop: shops[1]._id, name: 'Veg Momos (8 pcs)', price: 60, category: 'Momos', isVeg: true },
      { shop: shops[1]._id, name: 'Chicken Momos (8 pcs)', price: 80, category: 'Momos', isVeg: false },
      { shop: shops[1]._id, name: 'Fried Momos (8 pcs)', price: 70, category: 'Momos', isVeg: true },
      { shop: shops[1]._id, name: 'Paneer Roll', price: 70, category: 'Rolls', isVeg: true },
      { shop: shops[1]._id, name: 'Egg Roll', price: 60, category: 'Rolls', isVeg: false },
      { shop: shops[1]._id, name: 'Chicken Roll', price: 80, category: 'Rolls', isVeg: false },
      { shop: shops[1]._id, name: 'French Fries', price: 50, category: 'Fries', isVeg: true },
      { shop: shops[1]._id, name: 'Veg Sandwich', price: 50, category: 'Sandwich', isVeg: true },
      { shop: shops[1]._id, name: 'Club Sandwich', price: 80, category: 'Sandwich', isVeg: false },

      // Chinese Corner
      { shop: shops[2]._id, name: 'Veg Noodles', price: 70, category: 'Noodles', isVeg: true },
      { shop: shops[2]._id, name: 'Chicken Noodles', price: 90, category: 'Noodles', isVeg: false },
      { shop: shops[2]._id, name: 'Veg Fried Rice', price: 70, category: 'Rice', isVeg: true },
      { shop: shops[2]._id, name: 'Chicken Fried Rice', price: 90, category: 'Rice', isVeg: false },
      { shop: shops[2]._id, name: 'Veg Manchurian', price: 80, category: 'Chinese', isVeg: true },
      { shop: shops[2]._id, name: 'Chicken Manchurian', price: 100, category: 'Chinese', isVeg: false },
      { shop: shops[2]._id, name: 'Hot & Sour Soup', price: 60, category: 'Soup', isVeg: true },
      { shop: shops[2]._id, name: 'Spring Rolls (4 pcs)', price: 60, category: 'Chinese', isVeg: true },
      { shop: shops[2]._id, name: 'Veg Hakka Noodles', price: 80, category: 'Noodles', isVeg: true },
      { shop: shops[2]._id, name: 'Schezwan Fried Rice', price: 80, category: 'Rice', isVeg: true },

      // Brew Point
      { shop: shops[4]._id, name: 'Chai', price: 15, category: 'Tea', isVeg: true },
      { shop: shops[4]._id, name: 'Masala Chai', price: 20, category: 'Tea', isVeg: true },
      { shop: shops[4]._id, name: 'Black Coffee', price: 25, category: 'Coffee', isVeg: true },
      { shop: shops[4]._id, name: 'Cappuccino', price: 50, category: 'Coffee', isVeg: true },
      { shop: shops[4]._id, name: 'Cold Coffee', price: 60, category: 'Coffee', isVeg: true },
      { shop: shops[4]._id, name: 'Lemon Tea', price: 20, category: 'Tea', isVeg: true },
      { shop: shops[4]._id, name: 'Chocolate Shake', price: 80, category: 'Shakes', isVeg: true },
      { shop: shops[4]._id, name: 'Strawberry Shake', price: 80, category: 'Shakes', isVeg: true, needsVerification: true },
      { shop: shops[4]._id, name: 'Maggi', price: 30, category: 'Snacks', isVeg: true },
      { shop: shops[4]._id, name: 'Bread Omelette', price: 40, category: 'Snacks', isVeg: false },
      { shop: shops[4]._id, name: 'Poha', price: 25, category: 'Snacks', isVeg: true },
    ];

    await MenuItem.insertMany(menuData);
    console.log('Seed completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  }
}

seed();
