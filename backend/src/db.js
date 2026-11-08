const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { dbFile } = require('./config');

fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fixtures (
  id INTEGER PRIMARY KEY,            -- API-Football fixture id (negative in demo mode)
  date TEXT NOT NULL,                -- YYYY-MM-DD (local day)
  kickoff TEXT NOT NULL,             -- ISO timestamp
  league_id INTEGER, league_name TEXT, league_country TEXT,
  home TEXT NOT NULL, away TEXT NOT NULL,
  home_logo TEXT, away_logo TEXT,
  status TEXT NOT NULL DEFAULT 'NS', -- NS, LIVE, FT, PST, CANC ...
  home_goals INTEGER, away_goals INTEGER,
  exp_home REAL, exp_away REAL       -- model expected goals
);
CREATE INDEX IF NOT EXISTS idx_fixtures_date ON fixtures(date);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  tier TEXT NOT NULL,                -- low | medium | high
  market TEXT NOT NULL,              -- e.g. '1X2', 'Over/Under 2.5'
  pick TEXT NOT NULL,                -- e.g. 'Home', 'Over 2.5'
  pick_code TEXT NOT NULL,           -- machine code used for settling
  odds REAL NOT NULL,
  odds_source TEXT NOT NULL,         -- 'bookmaker' | 'model'
  probability REAL NOT NULL,
  confidence INTEGER NOT NULL,       -- 1..5 stars
  result TEXT NOT NULL DEFAULT 'pending', -- pending | won | lost | void
  UNIQUE(fixture_id, tier)
);
CREATE INDEX IF NOT EXISTS idx_pred_date ON predictions(date);

CREATE TABLE IF NOT EXISTS accas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  total_odds REAL NOT NULL,
  probability REAL NOT NULL,
  result TEXT NOT NULL DEFAULT 'pending',
  UNIQUE(date, key)
);

CREATE TABLE IF NOT EXISTS acca_legs (
  acca_id INTEGER NOT NULL REFERENCES accas(id) ON DELETE CASCADE,
  prediction_id INTEGER NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  PRIMARY KEY (acca_id, prediction_id)
);

CREATE TABLE IF NOT EXISTS user_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prediction_id INTEGER NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, prediction_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, date TEXT, ok INTEGER, message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migrations for databases created by earlier versions.
const accaCols = db.prepare('PRAGMA table_info(accas)').all().map(c => c.name);
if (!accaCols.includes('grp')) db.exec("ALTER TABLE accas ADD COLUMN grp TEXT NOT NULL DEFAULT 'long'");
if (!accaCols.includes('booking_code')) db.exec('ALTER TABLE accas ADD COLUMN booking_code TEXT');
if (!accaCols.includes('code_set_at')) db.exec('ALTER TABLE accas ADD COLUMN code_set_at TEXT');

// One booking code per ticket per bookmaker.
db.exec(`CREATE TABLE IF NOT EXISTS booking_codes (
  acca_id INTEGER NOT NULL REFERENCES accas(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  code TEXT NOT NULL,
  set_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (acca_id, platform)
)`);
// Move codes saved by the SportyBet-only version.
db.exec(`INSERT OR IGNORE INTO booking_codes (acca_id, platform, code)
  SELECT id, 'sportybet', booking_code FROM accas WHERE booking_code IS NOT NULL`);
db.exec('UPDATE accas SET booking_code = NULL WHERE booking_code IS NOT NULL');

const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('platform')) db.exec("ALTER TABLE users ADD COLUMN platform TEXT NOT NULL DEFAULT 'sportybet'");

// Sign-in is by phone number. Old email/password columns stay (unused) so existing databases keep working.
if (!userCols.includes('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone)');

// Telegram alerts: one chat per account, a short-lived link code, and per-alert switches.
for (const [col, ddl] of [
  ['telegram_chat_id', 'TEXT'], ['telegram_link_code', 'TEXT'], ['telegram_link_at', 'TEXT'],
  ['notify_picks', 'INTEGER NOT NULL DEFAULT 1'], ['notify_codes', 'INTEGER NOT NULL DEFAULT 1'],
]) if (!userCols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${ddl}`);

// Every alert sent, so the same one is never sent twice (admin refreshes, restarts, re-saved codes).
db.exec(`CREATE TABLE IF NOT EXISTS notification_log (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, ref TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind, ref)
)`);

// Booking-code posts written by the admin (no auto-generated tickets).
//  kind 'daily': shown for one day, removed at POST_EXPIRE_HOUR (default 12:00) the next day.
//  kind 'long' : kept until the last match has been played (expires_at = last kickoff + a few hours).
db.exec(`CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  last_match_at TEXT,
  expires_at TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// One entry per bookmaker: a code, or an image whose caption is the code, or a link.
db.exec(`CREATE TABLE IF NOT EXISTS post_entries (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  image_id TEXT,
  PRIMARY KEY (post_id, platform)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS post_images (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Results center: one row per booking-code post, kept after the post itself expires. The admin marks won/lost/void.
db.exec(`CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','void')),
  settled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('INSERT INTO results (post_id, kind, title, date) SELECT id, kind, title, date FROM posts WHERE id NOT IN (SELECT post_id FROM results WHERE post_id IS NOT NULL)');

// Premium subscriptions (paid through Paystack).
if (!userCols.includes('premium_until')) db.exec('ALTER TABLE users ADD COLUMN premium_until TEXT');
const postCols = db.prepare('PRAGMA table_info(posts)').all().map(c => c.name);
if (!postCols.includes('premium')) db.exec('ALTER TABLE posts ADD COLUMN premium INTEGER NOT NULL DEFAULT 0');
// Referrals: each user can pick a referral code; referred_by is who brought them in; ref_qualified_at is set when they first buy a
// qualifying pass; referral_rewards counts free-access rewards already given to the referrer.
{
  const uc = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!uc.includes('ref_code')) db.exec('ALTER TABLE users ADD COLUMN ref_code TEXT');
  if (!uc.includes('referred_by')) db.exec('ALTER TABLE users ADD COLUMN referred_by INTEGER');
  if (!uc.includes('ref_qualified_at')) db.exec('ALTER TABLE users ADD COLUMN ref_qualified_at TEXT');
  if (!uc.includes('referral_rewards')) db.exec('ALTER TABLE users ADD COLUMN referral_rewards INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_ref_code ON users (ref_code COLLATE NOCASE) WHERE ref_code IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS users_referred_by ON users (referred_by)');
}
// Admin tools: blocked accounts, and posts that go live on a later day (starts_at) and are announced when they do (notified).
{
  const uc = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!uc.includes('blocked')) db.exec('ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0');
  const pc = db.prepare('PRAGMA table_info(posts)').all().map(c => c.name);
  if (!pc.includes('starts_at')) db.exec('ALTER TABLE posts ADD COLUMN starts_at TEXT');
  if (!pc.includes('notified')) db.exec('ALTER TABLE posts ADD COLUMN notified INTEGER NOT NULL DEFAULT 1');
}
db.exec(`CREATE TABLE IF NOT EXISTS payments (
  reference TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  days INTEGER NOT NULL,
  amount INTEGER NOT NULL,            -- pesewas / kobo: the smallest unit, as Paystack uses
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | success
  channel TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id)');

module.exports = db;
