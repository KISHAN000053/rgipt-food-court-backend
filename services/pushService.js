const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

webpush.setVapidDetails(
  'mailto:kishan000053@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Sends a push notification to every subscription stored for a given user.
// Invalid/expired subscriptions (HTTP 410) are removed automatically so the
// database doesn't accumulate stale records. Any other error is logged but
// never throws — a notification failing must never break the order flow.
async function notifyUser(userId, payload) {
  const records = await PushSubscription.find({ user: userId });
  const results = await Promise.allSettled(
    records.map(async (record) => {
      try {
        await webpush.sendNotification(record.subscription, JSON.stringify(payload));
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await record.deleteOne();
        } else {
          console.error('[Push notification failed]', err.statusCode, err.body);
        }
      }
    })
  );
  return results;
}

module.exports = { notifyUser };
