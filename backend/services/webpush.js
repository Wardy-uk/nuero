const webpush = require('web-push');
const db = require('../db/database');

function isConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function init() {
  if (!isConfigured()) {
    console.log('[WebPush] Not configured — VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY required');
    return;
  }
  webpush.setVapidDetails(
    'mailto:nick.ward@nurtur.tech',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  console.log('[WebPush] Initialized');
}

async function sendToAll(title, body, data = {}) {
  if (!isConfigured()) return;

  const subscriptions = db.getAllPushSubscriptions();
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({
    title,
    body,
    data,
    icon: '/favicon.svg',
    badge: '/favicon.svg'
  });

  const results = await Promise.allSettled(
    subscriptions.map(sub => {
      const pushSub = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keys_p256dh,
          auth: sub.keys_auth
        }
      };
      return webpush.sendNotification(pushSub, payload).catch(err => {
        // 410 Gone or 404 = subscription expired, remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log('[WebPush] Removing expired subscription:', sub.endpoint.slice(0, 60));
          db.removePushSubscription(sub.endpoint);
        }
        throw err;
      });
    })
  );

  const sent = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  if (sent > 0 || failed > 0) {
    console.log(`[WebPush] Sent: ${sent}, Failed: ${failed}`);
  }
}

module.exports = { isConfigured, init, sendToAll };
