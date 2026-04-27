const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:info@hectoflex.ch';
const PUSH_ADMIN_KEY = process.env.PUSH_ADMIN_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: 'Missing env vars for push' });
  }
  if (PUSH_ADMIN_KEY && req.headers['x-api-key'] !== PUSH_ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { title, body, user_id } = req.body || {};
    const payload = JSON.stringify({
      title: title || 'HectoFlex',
      body: body || 'Rappel',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      url: '/'
    });

    let query = `${SUPABASE_URL}/rest/v1/push_subscriptions?select=endpoint,p256dh,auth`;
    if (user_id) query += `&user_id=eq.${encodeURIComponent(user_id)}`;

    const r = await fetch(query, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: 'load subscriptions failed', detail: t });
    }

    const subs = await r.json();
    if (!subs.length) return res.status(200).json({ ok: true, sent: 0, failed: 0 });

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    let sent = 0;
    let failed = 0;
    for (const s of subs) {
      const subscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth }
      };
      try {
        await webpush.sendNotification(subscription, payload, { TTL: 60 });
        sent++;
      } catch (e) {
        failed++;
      }
    }

    return res.status(200).json({ ok: true, sent, failed });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'send failed' });
  }
};
