require('dotenv').config();
const mongoose = require('mongoose');
const Hostel = require('../models/Hostel');

// Edit this list to match your real hostels, then run: node scripts/seedHostels.js
// It's idempotent — running it again won't create duplicates.
const hostels = [
  { name: 'Vidyasagar Hostel', roomPrefix: 'g', roomDigits: 3 },
  { name: 'Homi Bhabha Hostel', roomPrefix: 'h', roomDigits: 3 },
  { name: 'APJ Abdul Kalam Hostel', roomPrefix: 'g', roomDigits: 3 },
  { name: 'Aryabhatta Hostel', roomPrefix: 'a', roomDigits: 3 },
];

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    for (const h of hostels) {
      await Hostel.updateOne({ name: h.name }, { $setOnInsert: h }, { upsert: true });
    }
    console.log(`Seeded ${hostels.length} hostels (existing ones untouched).`);
    process.exit(0);
  } catch (err) {
    console.error('Hostel seed error:', err);
    process.exit(1);
  }
}

seed();
