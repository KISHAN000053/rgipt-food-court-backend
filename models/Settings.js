const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  // Singleton document — always fetched/updated by key: 'global'
  key: { type: String, default: 'global', unique: true },
  razorpaySurchargePercent: { type: Number, default: 2 }, // % markup shown to students on menu prices
  serviceFee: { type: Number, default: 2 }, // flat ₹ charged per order
}, { timestamps: true });

settingsSchema.statics.getGlobal = async function () {
  let settings = await this.findOne({ key: 'global' });
  if (!settings) {
    settings = await this.create({ key: 'global' });
  }
  return settings;
};

module.exports = mongoose.model('Settings', settingsSchema);
