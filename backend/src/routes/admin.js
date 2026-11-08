// Admin console API. Separate login and session from the public app.
const express = require('express');
const config = require('../config');
const { displayPhone, normalizePhone } = require('../phone');
const db = require('../db');
const engine = require('../engine');
const telegram = require('../telegram');
const notify = require('../notify');
const apiFootball = require('../apiFootball');
const settings = require('../settings');
const schedule = require('../schedule');
const { adminAuth, limited, setAdminSession, clearSession, ADMIN_COOKIE, publicUser } = require('../middleware/auth');
const { ticketsFor } = require('../services/tickets');

const router = express.Router();
const startedAt = new Date().toISOString();

// ---------- admin sign in ----------
router.post('/login', limited, (req, res) => {
  const phone = normalizePhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid phone number, e.g. 024 123 4567' });
  if (settings.passcodeSet() && !settings.checkPasscode(req.body.passcode)) return res.status(401).json({ error: 'Wrong phone number or passcode' });
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user || !user.is_admin) return res.status(403).json({ error: settings.passcodeSet() ? 'Wrong phone number or passcode' : 'That number is not an admin account' });
  const token = setAdminSession(res, user);
  res.json({ user: publicUser(user), token });
});
router.post('/logout', (req, res) => { clearSession(res, ADMIN_COOKIE); res.json({ ok: true }); });
router.get('/me', adminAuth, (req, res) => res.json({ user: publicUser(req.user), demo: !config.apiKey, platforms: config.platforms, passcodeSet: settings.passcodeSet() }));

router.post('/run', adminAuth, async (req, res) => {
  try {
    settings.log(displayPhone(req.user.phone), 'Refreshed predictions');
    const predict = await engine.dailyRun();
    notify.morning(engine.localDate(0)).catch(e => console.error('notify:', e.message)); // sends once per day
    const settled = await engine.settle();
    res.json({ predict, settled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Booking codes: the admin books each ticket on each bookmaker and pastes the codes here.
router.get('/tickets', adminAuth, (req, res) => {
  const dates = [engine.localDate(0), engine.localDate(1)];
  res.json({ days: dates.map(date => ({ date, tickets: ticketsFor(date) })), platforms: config.platforms });
});
// Body: { codes: { sportybet: 'ABC123', msport: '', ... } } — an empty value removes that code.
router.put('/tickets/:id/codes', adminAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM accas WHERE id = ?').get(id)) return res.status(404).json({ error: 'Ticket not found' });
  const codes = req.body.codes || {};
  for (const p of config.platforms) {
    if (!(p.key in codes)) continue;
    const code = String(codes[p.key] || '').trim().toUpperCase();
    if (code && !/^[A-Z0-9]{4,16}$/.test(code)) return res.status(400).json({ error: `${p.name} code should be 4–16 letters and numbers` });
  }
  const before = Object.fromEntries(db.prepare('SELECT platform, code FROM booking_codes WHERE acca_id = ?').all(id).map(r => [r.platform, r.code]));
  db.transaction(() => {
    for (const p of config.platforms) {
      if (!(p.key in codes)) continue;
      const code = String(codes[p.key] || '').trim().toUpperCase();
      if (code) db.prepare(`INSERT INTO booking_codes (acca_id, platform, code) VALUES (?,?,?)
        ON CONFLICT(acca_id, platform) DO UPDATE SET code = excluded.code, set_at = datetime('now')`).run(id, p.key, code);
      else db.prepare('DELETE FROM booking_codes WHERE acca_id = ? AND platform = ?').run(id, p.key);
    }
  })();
  const saved = Object.fromEntries(db.prepare('SELECT platform, code FROM booking_codes WHERE acca_id = ?').all(id).map(r => [r.platform, r.code]));
  // Tell users on a bookmaker whose code was just added or changed (never blocks the response).
  for (const [platform, code] of Object.entries(saved)) {
    if (before[platform] !== code) notify.codeAdded(id, platform, code).catch(e => console.error('notify:', e.message));
  }
  res.json({ ok: true, codes: saved });
});
// ---------- booking-code posts ----------
const posts = require('../posts');
const postErr = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not save the post' });
router.get('/posts', adminAuth, (req, res) => { posts.cleanup(); res.json({ posts: posts.active({ scheduled: true }), platforms: config.platforms.map(({ key, name, url }) => ({ key, name, url })), storage: { persistent: config.persistentStorage } }); });
router.post('/posts', adminAuth, (req, res) => {
  try {
    const id = posts.create({ kind: req.body.kind, title: req.body.title, lastMatchAt: req.body.lastMatchAt, entries: req.body.entries, date: req.body.date, by: displayPhone(req.user.phone) });
    settings.log(displayPhone(req.user.phone), `Posted ${req.body.kind === 'long' ? 'long bet' : "today's"} booking codes`);
    const post = posts.active().find(p => p.id === id); // a future day's post is announced when it goes live
    if (post) notify.postAdded(post).catch(e => console.error('notify:', e.message));
    res.json({ ok: true, id });
  } catch (e) { postErr(res, e); }
});
// Several days of codes at once (each day: { date, title, entries }).
router.post('/posts/bulk', adminAuth, (req, res) => {
  try {
    const ids = posts.createMany(req.body.days, displayPhone(req.user.phone));
    settings.log(displayPhone(req.user.phone), `Scheduled booking codes for ${ids.length} day${ids.length === 1 ? '' : 's'}`);
    for (const p of posts.active().filter(p => ids.includes(p.id))) notify.postAdded(p).catch(e => console.error('notify:', e.message));
    res.json({ ok: true, count: ids.length });
  } catch (e) { postErr(res, e); }
});
router.put('/posts/:id', adminAuth, (req, res) => {
  try { posts.update(Number(req.params.id), { title: req.body.title, lastMatchAt: req.body.lastMatchAt, entries: req.body.entries}); res.json({ ok: true }); }
  catch (e) { postErr(res, e); }
});
router.get('/premium', adminAuth, (req, res) => res.json(require('../premium').summary()));
const results = require('../results');
router.get('/results', adminAuth, (req, res) => res.json({ results: results.listAll() }));
router.put('/results/:id', adminAuth, (req, res) => {
  try { results.settle(Number(req.params.id), String(req.body.status || '')); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.delete('/posts/:id', adminAuth, (req, res) => {
  if (!posts.remove(Number(req.params.id))) return res.status(404).json({ error: 'Post not found' });
  settings.log(displayPhone(req.user.phone), 'Deleted a booking-code post');
  res.json({ ok: true });
});

// Admin dashboard: everything on one screen.
router.get('/overview', adminAuth, (req, res) => {
  const today = engine.localDate(0), tomorrow = engine.localDate(1), nowIso = new Date().toISOString();
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const users = one(`SELECT COUNT(*) total, COALESCE(SUM(is_admin),0) admins, COALESCE(SUM(telegram_chat_id IS NOT NULL),0) telegram,
      COALESCE(SUM(created_at >= datetime('now','-1 day')),0) day, COALESCE(SUM(created_at >= datetime('now','-7 day')),0) week FROM users`);
  const platforms = db.prepare('SELECT platform key, COUNT(*) n FROM users GROUP BY platform').all();

  const days = [today, tomorrow].map(date => {
    const c = one('SELECT COUNT(DISTINCT fixture_id) games, COUNT(*) picks FROM predictions WHERE date = ?', date);
    const tickets = db.prepare(`SELECT a.id, a.key, a.grp, a.name, a.total_odds, a.result,
        (SELECT COUNT(*) FROM acca_legs l WHERE l.acca_id = a.id) legs,
        (SELECT COUNT(*) FROM booking_codes b WHERE b.acca_id = a.id) codes,
        (SELECT MIN(f.kickoff) FROM acca_legs l JOIN predictions p ON p.id = l.prediction_id JOIN fixtures f ON f.id = p.fixture_id WHERE l.acca_id = a.id) first_kickoff
      FROM accas a WHERE a.date = ?`).all(date);
    const order = config.accas.map(x => x.key);
    tickets.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    return { date, games: c.games, picks: c.picks, tickets };
  });
  const codeCover = db.prepare(`SELECT b.platform, COUNT(DISTINCT b.acca_id) n FROM booking_codes b JOIN accas a ON a.id = b.acca_id
    WHERE a.date IN (?, ?) GROUP BY b.platform`).all(today, tomorrow);

  const tiers = Object.keys(config.tiers).map(k => {
    const r = one(`SELECT COALESCE(SUM(result='won'),0) won, COALESCE(SUM(result='lost'),0) lost,
      ROUND(COALESCE(SUM(CASE WHEN result='won' THEN odds - 1 WHEN result='lost' THEN -1 ELSE 0 END),0), 2) profit
      FROM predictions WHERE tier = ? AND date >= date('now','-30 day')`, k);
    return { key: k, label: config.tiers[k].label, ...r, hitRate: r.won + r.lost ? r.won / (r.won + r.lost) : null };
  });
  const longs = one(`SELECT COALESCE(SUM(result='won'),0) won, COALESCE(SUM(result='lost'),0) lost FROM accas WHERE date >= date('now','-30 day')`);

  const lastRun = kind => db.prepare('SELECT date, ok, message, created_at FROM runs WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind) || null;
  const failed24 = one("SELECT COUNT(*) n FROM runs WHERE ok = 0 AND created_at >= datetime('now','-1 day')").n;
  const sent = since => Object.fromEntries(db.prepare('SELECT kind, COUNT(*) n FROM notification_log WHERE sent_at >= datetime(\'now\', ?) GROUP BY kind').all(since).map(r => [r.kind, r.n]));

  // Things the admin should look at, most urgent first.
  const attention = [];
  const lp = lastRun('predict');
  if (lp && !lp.ok) attention.push({ level: 'bad', text: `The last prediction run failed: ${lp.message}`, goto: 'activity' });
  if (!days[0].picks && !days[1].picks) attention.push({ level: 'bad', text: 'There are no predictions for today or tomorrow yet.', action: 'run' });
  for (const d of days) {
    const open = d.tickets.filter(t => !t.codes && t.first_kickoff && t.first_kickoff > nowIso);
    if (open.length) attention.push({ level: 'warn', text: `${open.length} ticket${open.length > 1 ? 's' : ''} for ${d.date === today ? 'today' : 'tomorrow'} still need booking codes.`, goto: 'codes' });
  }
  if (!settings.passcodeSet()) attention.push({ level: process.env.NODE_ENV === 'production' ? 'bad' : 'info', text: 'Admin login uses a phone number only. Set a passcode in Settings so a guessed number cannot open this console.', goto: 'settings' });
  if (!config.apiKey) attention.push({ level: 'info', text: 'Sample games are shown. Add your API-Football key in Settings to use real fixtures.', goto: 'settings' });
  if (!telegram.enabled()) attention.push({ level: 'info', text: 'Telegram alerts are off. Add a bot token in Settings to turn them on.', goto: 'settings' });

  res.json({
    now: nowIso, today, tomorrow, users, platforms, days, codeCover, tiers, longs, attention,
    platformNames: Object.fromEntries(config.platforms.map(p => [p.key, p.name])),
    runs: { predict: lastRun('predict'), settle: lastRun('settle'), failed24 },
    notifications: { day: sent('-1 day'), week: sent('-7 day') },
    telegram: { enabled: telegram.enabled(), bot: telegram.bot(), linked: users.telegram },
    api: { mode: config.apiKey ? 'live' : 'demo', calls: apiFootball.callCount(), since: startedAt },
    schedule: { predict: config.predictCron, settle: config.settleCron, timezone: config.timezone },
  });
});

router.get('/users', adminAuth, (req, res) => {
  res.json({ users: db.prepare(`SELECT id, phone, is_admin, blocked, premium_until, platform, created_at, telegram_chat_id IS NOT NULL AS telegram,
      (SELECT COUNT(*) FROM user_picks p WHERE p.user_id = users.id) AS picks
    FROM users ORDER BY id DESC LIMIT 500`).all().map(u => ({ ...u, name: displayPhone(u.phone), is_admin: !!u.is_admin, blocked: !!u.blocked, premium_until: u.premium_until && new Date(u.premium_until) > new Date() ? u.premium_until : null, telegram: !!u.telegram })) });
});
router.put('/users/:id/admin', adminAuth, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't change your own admin access" });
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body.isAdmin ? 1 : 0, id);
  settings.log(displayPhone(req.user.phone), req.body.isAdmin ? 'Gave admin access' : 'Removed admin access', displayPhone(db.prepare('SELECT phone FROM users WHERE id = ?').get(id).phone));
  res.json({ ok: true });
});
router.post('/settle', adminAuth, async (req, res) => {
  try { res.json(await engine.settle()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/runs', adminAuth, (req, res) => {
  res.json({ runs: db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 30').all() });
});

// ---------- settings: everything that used to need a server variable ----------
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });
// After saving, apply what needs a restart of a background job.
function afterSave(changed) {
  if (changed.some(k => ['predictCron', 'settleCron', 'timezone'].includes(k))) schedule.start();
  if (changed.includes('telegramToken')) telegram.startPolling().catch(e => console.warn('telegram:', e.message));
}
const SECTION_NAMES = { apiKey: 'API-Football key', telegramToken: 'Telegram bot token' };
const describe = keys => keys.map(k => SECTION_NAMES[k] || k).join(', ');

router.get('/settings', adminAuth, (req, res) => res.json(settings.view()));
router.put('/settings', adminAuth, (req, res) => {
  try {
    const changed = settings.save(req.body);
    afterSave(changed);
    settings.log(displayPhone(req.user.phone), 'Changed settings', describe(changed));
    res.json(settings.view());
  } catch (e) { fail(res, e); }
});
// Forget the dashboard value and go back to the server variable / built-in default.
router.delete('/settings/:key', adminAuth, (req, res) => {
  try {
    settings.reset(req.params.key); afterSave([req.params.key]);
    settings.log(displayPhone(req.user.phone), 'Reset setting', describe([req.params.key]));
    res.json(settings.view());
  } catch (e) { fail(res, e); }
});
router.put('/settings/passcode', adminAuth, (req, res) => {
  try {
    settings.setPasscode(req.body && req.body.passcode);
    settings.log(displayPhone(req.user.phone), req.body && req.body.passcode ? 'Changed the admin passcode' : 'Removed the dashboard passcode');
    res.json(settings.view());
  } catch (e) { fail(res, e); }
});
// "Test" buttons: check a key or token works without saving anything.
router.post('/settings/test', adminAuth, async (req, res) => {
  try {
    if (req.body.target === 'apiKey') {
      if (!config.apiKey) return res.json({ ok: false, message: 'No API-Football key is set yet.' });
      const s = await apiFootball.status();
      const used = s.requests ? `${s.requests.current} of ${s.requests.limit_day} calls used today` : 'connected';
      return res.json({ ok: true, message: `API-Football works (${(s.subscription && s.subscription.plan) || 'account'}, ${used}).` });
    }
    if (req.body.target === 'telegram') {
      if (!telegram.enabled()) return res.json({ ok: false, message: 'No Telegram bot token is set yet.' });
      return res.json({ ok: true, message: `Telegram works. The bot is @${await telegram.check()}.` });
    }
    res.status(400).json({ error: 'Unknown test' });
  } catch (e) { res.json({ ok: false, message: e.message }); }
});

// ---------- users: add and remove accounts ----------
router.post('/users', adminAuth, (req, res) => {
  const phone = normalizePhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid phone number, e.g. 024 123 4567' });
  if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) return res.status(409).json({ error: 'That number already has an account' });
  const platform = config.platforms.some(p => p.key === req.body.platform) ? req.body.platform : config.platforms[0].key;
  db.prepare("INSERT INTO users (name, email, password_hash, phone, is_admin, platform) VALUES ('', ?, '', ?, ?, ?)")
    .run(phone + '@phone.local', phone, req.body.isAdmin ? 1 : 0, platform);
  settings.log(displayPhone(req.user.phone), 'Added a user', displayPhone(phone));
  res.json({ ok: true });
});
router.delete('/users/:id', adminAuth, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  const u = db.prepare('SELECT phone FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET referred_by = NULL WHERE referred_by = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id); // saved picks, payments and alert history go with it
  settings.log(displayPhone(req.user.phone), 'Deleted a user', displayPhone(u.phone));
  res.json({ ok: true });
});

// Block or unblock an account (a blocked user is logged out at once and cannot log in).
router.put('/users/:id/block', adminAuth, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't block your own account" });
  const u = db.prepare('SELECT phone, is_admin FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.is_admin) return res.status(400).json({ error: 'Remove their admin access first, then block them' });
  db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(req.body.blocked ? 1 : 0, id);
  settings.log(displayPhone(req.user.phone), req.body.blocked ? 'Blocked a user' : 'Unblocked a user', displayPhone(u.phone));
  res.json({ ok: true });
});
// Free access for chosen people: days > 0 adds that many days (after any pass they already have); days = 0 ends their access now.
router.put('/users/:id/access', adminAuth, (req, res) => {
  const id = Number(req.params.id), days = Math.floor(Number(req.body.days));
  if (!Number.isFinite(days) || days < 0 || days > 3650) return res.status(400).json({ error: 'Enter 0 to remove access, or 1 to 3650 days' });
  const u = db.prepare('SELECT phone, premium_until FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  let until = null;
  if (days > 0) {
    const base = u.premium_until && new Date(u.premium_until) > new Date() ? new Date(u.premium_until) : new Date();
    until = new Date(base.getTime() + days * 86400000).toISOString();
  }
  db.prepare('UPDATE users SET premium_until = ? WHERE id = ?').run(until, id);
  settings.log(displayPhone(req.user.phone), days ? `Gave ${days} days of free access` : 'Removed free access', displayPhone(u.phone));
  res.json({ ok: true, until });
});

// ---------- tickets: remove one (it is rebuilt on the next refresh while it is still listed in Settings) ----------
router.delete('/tickets/:id', adminAuth, (req, res) => {
  const id = Number(req.params.id);
  const t = db.prepare('SELECT name, date FROM accas WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  db.prepare('DELETE FROM accas WHERE id = ?').run(id);
  settings.log(displayPhone(req.user.phone), 'Deleted a ticket', `${t.name}, ${t.date}`);
  res.json({ ok: true });
});

// ---------- Telegram message to users ----------
router.post('/broadcast', adminAuth, async (req, res) => {
  const msg = String((req.body && req.body.message) || '').trim();
  if (!msg) return res.status(400).json({ error: 'Write a message first' });
  if (msg.length > 1000) return res.status(400).json({ error: 'Keep the message under 1000 characters' });
  if (!telegram.enabled()) return res.status(400).json({ error: 'Telegram is not set up. Add a bot token in Settings.' });
  const only = req.body.platform && req.body.platform !== 'all' ? req.body.platform : null;
  const users = db.prepare(`SELECT telegram_chat_id FROM users WHERE telegram_chat_id IS NOT NULL ${only ? 'AND platform = ?' : ''}`).all(...(only ? [only] : []));
  let sent = 0;
  for (const u of users) if (await telegram.send(u.telegram_chat_id, telegram.escapeHtml(msg))) sent++;
  settings.log(displayPhone(req.user.phone), 'Sent a Telegram message', `${sent} of ${users.length} delivered`);
  res.json({ sent, total: users.length });
});

router.get('/log', adminAuth, (req, res) => res.json({ log: settings.recentLog() }));

module.exports = router;
