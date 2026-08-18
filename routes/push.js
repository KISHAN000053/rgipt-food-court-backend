const express = require('express');
const router = express.Router();
const PushSubscription = require('../models/PushSubscription');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

// The client needs the VAPID public key to create its subscription.
// This endpoint is public — no auth needed, it's not sensitive.
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Saves (or updates) a browser push subscription for the current user.
// Idempotent — if the same endpoint is already stored, just update it in
// place rather than creating a duplicate.
router.post('/subscribe', requireAuth, asyncHandler(async (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) {
    return res.status(400).json({ message: 'Invalid subscription object.' });
  }
  await PushSubscription.findOneAndUpdate(
    { user: req.user._id, 'subscription.endpoint': subscription.endpoint },
    { user: req.user._id, subscription },
    { upsert: true, new: true }
  );
  res.json({ message: 'Subscribed.' });
}));

// Removes a specific subscription — called when a user manually disables
// notifications in the app, or when they sign out.
router.post('/unsubscribe', requireAuth, asyncHandler(async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) {
    await PushSubscription.deleteMany({ user: req.user._id, 'subscription.endpoint': endpoint });
  }
  res.json({ message: 'Unsubscribed.' });
}));

module.exports = router;
