// Phone alerts (web push). The VAPID keys that identify this server are taken from the environment, or generated once and
// stored beside the database so they survive restarts.
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const config = require('./config');
const db = require('./db');

function keys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY.trim(), privateKey: process.env.VAPID_PRIVATE_KEY.trim() };
  const file = path.join(path.dirname(config.dbFile), '.vapid_keys.json');
  try { const k = JSON.parse(fs.readFileSync(file, 'utf8')); if (k.publicKey && k.privateKey) return k; } catch { /* generate below */ }
  const k = webpush.generateVAPIDKeys();
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(k), { mode: 0o600 }); }
  catch (e) { console.warn('Could not save the push keys, so phone alerts will need re-enabling after a restart:', e.message); }
  return k;
}
const vapid = keys();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || (config.siteUrl && /^https:/.test(config.siteUrl) ? config.siteUrl : 'mailto:admin@pawaodds.com'), vapid.publicKey, vapid.privateKey);

const publicKey = () => vapid.publicKey;

function subscribe(userId, sub) {
  const ok = sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000
    && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
  if (!ok) throw Object.assign(new Error('That notification setup is not valid'), { status: 400 });
  db.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`).run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}
const unsubscribe = (userId, endpoint) => db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint || ''));
const has = userId => !!db.prepare('SELECT 1 FROM push_subs WHERE user_id = ?').get(userId);

// Sends to every device a user turned alerts on for. Dead subscriptions (404/410) are forgotten. Returns how many were delivered.
async function sendToUser(userId, { title, body, url }) {
  let sent = 0;
  for (const s of db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId)) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body, url: url || '/' }), { TTL: 6 * 3600, timeout: 15000 });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);
      else console.error('push:', e.statusCode || e.message);
    }
  }
  return sent;
}

module.exports = { publicKey, subscribe, unsubscribe, has, sendToUser };
