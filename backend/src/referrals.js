// Referral program: a user shares their own code; when enough of the people they brought in have bought a qualifying pass,
// the referrer gets free access for a set number of days (and again for every further group).
const db = require('./db');
const config = require('./config');

const CODE_RE = /^[A-Za-z0-9_-]{3,20}$/;
const RESERVED = new Set(['admin', 'pawaodds', 'support', 'free', 'premium', 'null', 'undefined']);

function cleanCode(v) {
  const c = String(v || '').trim();
  if (!CODE_RE.test(c)) throw Object.assign(new Error('Use 3 to 20 letters, numbers, - or _ (no spaces)'), { status: 400 });
  if (RESERVED.has(c.toLowerCase())) throw Object.assign(new Error('That code is not available. Try another.'), { status: 400 });
  return c;
}

function setCode(userId, code) {
  const c = cleanCode(code);
  const clash = db.prepare('SELECT id FROM users WHERE ref_code = ? COLLATE NOCASE AND id != ?').get(c, userId);
  if (clash) throw Object.assign(new Error('Someone already uses that code. Try another.'), { status: 409 });
  db.prepare('UPDATE users SET ref_code = ? WHERE id = ?').run(c, userId);
  return c;
}

// At signup: the code a new user typed (or arrived with). Returns the referrer's id, or throws if the code does not exist.
function resolve(code) {
  const c = String(code || '').trim();
  if (!c) return null;
  const u = CODE_RE.test(c) ? db.prepare('SELECT id FROM users WHERE ref_code = ? COLLATE NOCASE').get(c) : null;
  if (!u) throw Object.assign(new Error('That referral code does not exist. Check it, or clear the box.'), { status: 400 });
  return u.id;
}

const DAY = 86400000;
// Called inside the payment transaction when a pass is paid for.
function onPurchase(userId, plan) {
  const cfg = config.referral;
  if (!cfg.plans.includes(plan)) return;
  const u = db.prepare('SELECT referred_by, ref_qualified_at FROM users WHERE id = ?').get(userId);
  if (!u || !u.referred_by || u.ref_qualified_at) return;
  db.prepare('UPDATE users SET ref_qualified_at = ? WHERE id = ?').run(new Date().toISOString(), userId);
  const n = db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by = ? AND ref_qualified_at IS NOT NULL').get(u.referred_by).c;
  const owner = db.prepare('SELECT premium_until, referral_rewards FROM users WHERE id = ?').get(u.referred_by);
  if (!owner) return;
  const earned = Math.floor(n / cfg.target);
  if (earned <= owner.referral_rewards) return;
  let until = owner.premium_until && new Date(owner.premium_until) > new Date() ? new Date(owner.premium_until) : new Date();
  until = new Date(until.getTime() + (earned - owner.referral_rewards) * cfg.rewardDays * DAY);
  db.prepare('UPDATE users SET premium_until = ?, referral_rewards = ? WHERE id = ?').run(until.toISOString(), earned, u.referred_by);
}

// 024 *** 003: enough to recognise a friend, not enough to contact them.
const mask = phone => {
  const d = String(phone || '').replace(/\D/g, ''), n = d.startsWith('233') ? '0' + d.slice(3) : d;
  return n.length > 6 ? n.slice(0, 3) + ' *** ' + n.slice(-3) : '***';
};

function summary(userId) {
  const cfg = config.referral;
  const me = db.prepare('SELECT ref_code, referral_rewards FROM users WHERE id = ?').get(userId);
  const rows = db.prepare('SELECT phone, created_at, ref_qualified_at FROM users WHERE referred_by = ? ORDER BY id DESC LIMIT 100').all(userId);
  const qualified = db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by = ? AND ref_qualified_at IS NOT NULL').get(userId).c;
  return {
    code: me.ref_code || '', target: cfg.target, rewardDays: cfg.rewardDays, rewardMonths: Math.round(cfg.rewardDays / 30),
    qualified, joined: rows.length, progress: qualified % cfg.target, rewards: me.referral_rewards,
    referred: rows.map(r => ({ who: mask(r.phone), joinedAt: r.created_at, purchased: !!r.ref_qualified_at })),
  };
}

module.exports = { setCode, resolve, onPurchase, summary };
