const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

const vapidConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (vapidConfigured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('[Push notifications] VAPID keys are not configured; push delivery is disabled.');
}

// Sends a push notification to every subscription stored for a given user.
// Invalid/expired subscriptions (HTTP 410/404) are removed automatically. Push is
// optional and must never break checkout or order-status changes when unconfigured.
async function notifyUser(userId, payload) {
  if (!vapidConfigured) return [];

  const records = await PushSubscription.find({ user: userId });
  const results = await Promise.allSettled(
    records.map(async (record) => {
      try {
        await webpush.sendNotification(record.subscription, JSON.stringify(payload));
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await record.deleteOne();
        } else {
          console.error('[Push notification failed]', err.statusCode, err.message || 'Unknown push error');
        }
      }
    })
  );
  return results;
}

module.exports = { notifyUser };
