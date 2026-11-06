// Settings the admin console can change while the server is running.
// They are saved in the database and override the server variables (.env / Railway) until reset.
// Not editable here on purpose: JWT_SECRET, CORS_ORIGINS, cookie options, DB_FILE and PORT. A wrong value
// in any of those can lock everyone (including you) out, so they stay on the server.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const config = require('./config');
const db = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, admin TEXT, action TEXT NOT NULL, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const clone = v => JSON.parse(JSON.stringify(v));
const SECRETS = ['apiKey', 'telegramToken'];
const ARRAYS = ['leagues', 'accas', 'platforms'];
// What the server variables say, kept so "reset" can go back to them.
const DEFAULTS = clone({
  siteUrl: config.siteUrl, timezone: config.timezone, predictCron: config.predictCron, settleCron: config.settleCron,
  bookmakerId: config.bookmakerId, apiKey: config.apiKey, telegramToken: config.telegramToken,
  leagues: config.leagues, tiers: config.tiers, accas: config.accas, platforms: config.platforms,
});
const ENV_PASSCODE = config.adminPasscode;

// ---------- validation: every checker returns the cleaned value or throws a 400 ----------
const bad = m => { throw Object.assign(new Error(m), { status: 400 }); };
const text = (v, name, max) => { const s = String(v ?? '').trim(); if (!s) bad(`${name} can't be empty`); if (s.length > max) bad(`${name} is too long`); return s; };
const num = (v, name, min, max) => { const n = Number(v); if (v === '' || v == null || !Number.isFinite(n) || n < min || n > max) bad(`${name} must be a number from ${min} to ${max}`); return n; };
const int = (v, name, min, max) => { const n = num(v, name, min, max); if (!Number.isInteger(n)) bad(`${name} must be a whole number`); return n; };
const slug = (v, what) => { const s = String(v ?? '').trim().toLowerCase(); if (!/^[a-z0-9_]{2,24}$/.test(s)) bad(`${what}: the key must be 2–24 letters, numbers or underscores`); return s; };
const list = (v, name, min, max) => { if (!Array.isArray(v) || v.length < min || v.length > max) bad(`${name}: add between ${min} and ${max}`); return v; };
const unique = (items, field, name) => { if (new Set(items.map(i => i[field])).size !== items.length) bad(`${name}: two entries share the same ${field}`); return items; };
const url = (v, name) => { const s = String(v ?? '').trim().replace(/\/$/, ''); if (s && !/^https?:\/\/[^\s]+$/i.test(s)) bad(`${name} must start with http:// or https://`); return s; };
const TIERS = ['low', 'medium', 'high'];

const VALIDATE = {
  siteUrl: v => url(v, 'Site address'),
  timezone: v => { const s = text(v, 'Time zone', 60); try { new Intl.DateTimeFormat('en-CA', { timeZone: s }); } catch { bad('Unknown time zone. Use a name like Africa/Accra'); } return s; },
  predictCron: v => { const s = text(v, 'Prediction schedule', 60); if (!cron.validate(s)) bad('Prediction schedule is not valid'); return s; },
  settleCron: v => { const s = text(v, 'Settle schedule', 60); if (!cron.validate(s)) bad('Settle schedule is not valid'); return s; },
  bookmakerId: v => int(v, 'Odds bookmaker id', 1, 9999),
  apiKey: v => { const s = text(v, 'API-Football key', 80); if (/\s/.test(s) || s.length < 8) bad('That API-Football key looks wrong'); return s; },
  telegramToken: v => { const s = text(v, 'Telegram bot token', 100); if (!/^\d+:[\w-]{20,}$/.test(s)) bad('That Telegram token looks wrong. It should look like 123456:ABC-DEF…'); return s; },
  leagues: v => unique(list(v, 'Leagues', 1, 60).map(l => ({
    id: int(l.id, 'League id', 1, 999999), name: text(l.name, 'League name', 60), country: text(l.country, 'League country', 40),
  })), 'id', 'Leagues'),
  tiers: v => {
    const out = {};
    for (const k of TIERS) {
      const t = (v && v[k]) || bad(`Odds band "${k}" is missing`);
      const min = num(t.min, `${k}: lowest odds`, 1.01, 100), max = num(t.max, `${k}: highest odds`, 1.02, 1000);
      if (max <= min) bad(`${k}: highest odds must be above lowest odds`);
      out[k] = { label: text(t.label, `${k}: name`, 30), min, max, minProb: num(t.minProb, `${k}: lowest chance`, 0, 1) };
    }
    return out;
  },
  accas: v => unique(list(v, 'Tickets', 1, 20).map(a => {
    const key = slug(a.key, `Ticket "${a.name || ''}"`), name = text(a.name, 'Ticket name', 50);
    if (!['long', 'low', 'medium', 'high'].includes(a.group)) bad(`${name}: pick where the ticket is shown`);
    const pool = [...new Set(Array.isArray(a.pool) ? a.pool : [])].filter(t => TIERS.includes(t));
    if (!pool.length) bad(`${name}: choose at least one odds band to take games from`);
    const spec = { key, group: a.group, name, target: num(a.target, `${name}: target odds`, 1.5, 100000) };
    if (a.minLegs !== '' && a.minLegs != null) spec.minLegs = int(a.minLegs, `${name}: fewest games`, 2, 40);
    spec.maxLegs = int(a.maxLegs, `${name}: most games`, 2, 40);
    if (spec.minLegs && spec.maxLegs < spec.minLegs) bad(`${name}: most games can't be below fewest games`);
    spec.pool = pool; spec.minProb = num(a.minProb, `${name}: lowest chance per game`, 0, 1);
    return spec;
  }), 'key', 'Tickets'),
  platforms: v => unique(list(v, 'Bookmakers', 1, 12).map(p => ({
    key: slug(p.key, `Bookmaker "${p.name || ''}"`), name: text(p.name, 'Bookmaker name', 30),
    url: url(p.url, 'Bookmaker link') || bad('Bookmaker link can\'t be empty'),
  })), 'key', 'Bookmakers'),
};
const KEYS = Object.keys(VALIDATE);

// ---------- applying ----------
// Other modules hold references to these arrays/objects, so they are changed in place, never replaced.
function applyOne(key, value) {
  if (ARRAYS.includes(key)) config[key].splice(0, config[key].length, ...clone(value));
  else if (key === 'tiers') { for (const k of Object.keys(config.tiers)) delete config.tiers[k]; Object.assign(config.tiers, clone(value)); }
  else config[key] = value;
}
const overriddenKeys = () => new Set(db.prepare('SELECT key FROM settings').all().map(r => r.key));

// Read saved settings at start-up.
function load() {
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    if (!VALIDATE[key]) continue;
    try { applyOne(key, VALIDATE[key](JSON.parse(value))); }
    catch (e) { console.warn(`Ignoring saved setting "${key}": ${e.message}`); }
  }
}

// Save a partial update { key: value }. A blank secret goes back to the server variable.
function save(patch) {
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!VALIDATE[k]) bad(`Unknown setting: ${k}`);
    clean[k] = SECRETS.includes(k) && v === '' ? null : VALIDATE[k](v);
  }
  db.transaction(() => {
    for (const [k, v] of Object.entries(clean)) {
      if (v === null) db.prepare('DELETE FROM settings WHERE key = ?').run(k);
      else db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(k, JSON.stringify(v));
    }
  })();
  for (const [k, v] of Object.entries(clean)) applyOne(k, v === null ? clone(DEFAULTS[k]) : v);
  if (clean.platforms) { // users on a removed bookmaker move to the first one
    const keys = config.platforms.map(p => p.key);
    db.prepare(`UPDATE users SET platform = ? WHERE platform NOT IN (${keys.map(() => '?').join(',')})`).run(keys[0], ...keys);
  }
  return Object.keys(clean);
}

// Forget the dashboard value for one setting and go back to the server variable.
function reset(key) {
  if (!VALIDATE[key]) bad(`Unknown setting: ${key}`);
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  applyOne(key, clone(DEFAULTS[key]));
}

// ---------- admin passcode (stored hashed; replaces ADMIN_PASSCODE once set here) ----------
const hashRow = () => (db.prepare("SELECT value FROM settings WHERE key = 'passcode_hash'").get() || {}).value || '';
const passcodeSet = () => !!(hashRow() || ENV_PASSCODE);
function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function checkPasscode(input) {
  const h = hashRow();
  if (h) return bcrypt.compareSync(String(input || ''), h);
  return ENV_PASSCODE ? sameText(input || '', ENV_PASSCODE) : true;
}
// A blank passcode removes the dashboard one (the server's ADMIN_PASSCODE, if any, applies again).
function setPasscode(p) {
  p = String(p || '');
  if (!p) return void db.prepare("DELETE FROM settings WHERE key = 'passcode_hash'").run();
  if (p.length < 6 || p.length > 64) bad('The passcode must be 6 to 64 characters');
  db.prepare(`INSERT INTO settings (key, value) VALUES ('passcode_hash', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(bcrypt.hashSync(p, 10));
}

// ---------- what the console shows ----------
const hint = s => (s ? '••••' + String(s).slice(-4) : '');
function view() {
  const over = overriddenKeys();
  const secret = k => ({ set: !!config[k], hint: hint(config[k]), source: config[k] ? (over.has(k) ? 'dashboard' : 'server') : null });
  return {
    general: { siteUrl: config.siteUrl, timezone: config.timezone, predictCron: config.predictCron, settleCron: config.settleCron, bookmakerId: config.bookmakerId },
    secrets: { apiKey: secret('apiKey'), telegramToken: secret('telegramToken'), passcode: { set: passcodeSet(), source: hashRow() ? 'dashboard' : ENV_PASSCODE ? 'server' : null } },
    leagues: clone(config.leagues), tiers: clone(config.tiers), accas: clone(config.accas), platforms: clone(config.platforms),
    overridden: KEYS.filter(k => over.has(k)),
    serverOnly: {
      corsOrigins: config.corsOrigins, cookieSameSite: config.cookieSameSite, port: config.port, dbFile: config.dbFile,
      adminPhones: config.adminPhones.length, sessionSecretOk: config.jwtSecretSource === 'env' || config.jwtSecretSource === 'file' || config.jwtSecretSource === 'generated',
    },
  };
}

// ---------- a record of what admins changed ----------
function log(admin, action, detail = '') {
  db.prepare('INSERT INTO admin_log (admin, action, detail) VALUES (?,?,?)').run(admin || '', action, String(detail).slice(0, 300));
  db.prepare('DELETE FROM admin_log WHERE id <= (SELECT MAX(id) FROM admin_log) - 500').run();
}
const recentLog = (n = 40) => db.prepare('SELECT admin, action, detail, created_at FROM admin_log ORDER BY id DESC LIMIT ?').all(n);

module.exports = { load, save, reset, view, passcodeSet, checkPasscode, setPasscode, log, recentLog, KEYS };
