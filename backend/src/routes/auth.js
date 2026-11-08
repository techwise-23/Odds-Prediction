// Public app: sign up / log in (phone number only) and the user's own settings.
const express = require('express');
const config = require('../config');
const { normalizePhone } = require('../phone');
const db = require('../db');
const telegram = require('../telegram');
const referrals = require('../referrals');
const { auth, limited, setUserSession, clearSession, USER_COOKIE, publicUser } = require('../middleware/auth');

const router = express.Router();
const setSession = setUserSession;

// Sign up and log in use the phone number only.
function phoneFrom(req, res) {
  const phone = normalizePhone(req.body && req.body.phone);
  if (!phone) res.status(400).json({ error: 'Enter a valid phone number, e.g. 024 123 4567' });
  return phone;
}
router.post('/register', limited, (req, res) => {
  const phone = phoneFrom(req, res); if (!phone) return;
  if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) return res.status(409).json({ error: 'That number already has an account. Tap Log in instead.' });
  // With ADMIN_PHONES set, only those numbers are admins; otherwise the very first account is.
  const isAdmin = config.adminPhones.includes(phone) || (!config.adminPhones.length && db.prepare('SELECT COUNT(*) c FROM users').get().c === 0);
  let referrer = null;
  try { referrer = referrals.resolve(req.body && req.body.ref); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const { lastInsertRowid } = db.prepare("INSERT INTO users (name, email, password_hash, phone, is_admin, referred_by) VALUES ('', ?, '', ?, ?, ?)")
    .run(phone + '@phone.local', phone, isAdmin ? 1 : 0, referrer);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
  const token = setSession(res, user);
  res.json({ user: publicUser(user), token });
});

router.post('/login', limited, (req, res) => {
  const phone = phoneFrom(req, res); if (!phone) return;
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) return res.status(404).json({ error: 'No account for that number yet. Tap Sign up to create one.' });
  const token = setSession(res, user);
  res.json({ user: publicUser(user), token });
});

router.post('/logout', (req, res) => { clearSession(res, USER_COOKIE); res.json({ ok: true }); });
router.get('/me', auth, (req, res) => res.json({ user: publicUser(req.user), demo: !config.apiKey, platforms: config.platforms, telegram: telegram.enabled() }));
router.put('/me/platform', auth, (req, res) => {
  const platform = String(req.body.platform || '');
  if (!config.platforms.some(p => p.key === platform)) return res.status(400).json({ error: 'Unknown bookmaker' });
  db.prepare('UPDATE users SET platform = ? WHERE id = ?').run(platform, req.user.id);
  res.json({ ok: true, platform });
});


// ---------- Referrals ----------
router.get('/referrals', auth, (req, res) => res.json(referrals.summary(req.user.id)));
router.put('/referrals/code', auth, (req, res) => {
  try { referrals.setCode(req.user.id, req.body && req.body.code); res.json(referrals.summary(req.user.id)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------- Telegram alerts ----------
function telegramState(u) {
  return { enabled: telegram.enabled(), bot: telegram.bot(), linked: !!u.telegram_chat_id,
    notifyPicks: !!u.notify_picks, notifyCodes: !!u.notify_codes };
}
const freshUser = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
router.get('/me/telegram', auth, (req, res) => res.json(telegramState(req.user)));
// Start linking: the user opens this link in Telegram and taps Start.
router.post('/me/telegram/link', auth, (req, res) => {
  if (!telegram.enabled()) return res.status(400).json({ error: 'Telegram alerts are not set up on this site' });
  if (!telegram.bot()) return res.status(503).json({ error: 'The Telegram bot is not ready yet. Try again in a moment.' });
  const code = telegram.newLinkCode(req.user.id);
  res.json({ url: `https://t.me/${telegram.bot()}?start=${code}`, bot: telegram.bot() });
});
router.put('/me/telegram', auth, (req, res) => {
  const b = req.body || {};
  if (typeof b.notifyPicks === 'boolean') db.prepare('UPDATE users SET notify_picks = ? WHERE id = ?').run(+b.notifyPicks, req.user.id);
  if (typeof b.notifyCodes === 'boolean') db.prepare('UPDATE users SET notify_codes = ? WHERE id = ?').run(+b.notifyCodes, req.user.id);
  res.json(telegramState(freshUser(req.user.id)));
});
router.delete('/me/telegram', auth, (req, res) => {
  db.prepare('UPDATE users SET telegram_chat_id = NULL, telegram_link_code = NULL WHERE id = ?').run(req.user.id);
  res.json(telegramState(freshUser(req.user.id)));
});


module.exports = router;
