// Promo codes: a percentage off a pass. Counted as used only when the payment succeeds.
const db = require('./db');

const CODE_RE = /^[A-Za-z0-9_-]{3,20}$/;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const row = p => ({ id: p.id, code: p.code, percent: p.percent, plans: p.plans ? p.plans.split(',') : [], maxUses: p.max_uses, used: p.used,
  expiresAt: p.expires_at, active: !!p.active });

function create({ code, percent, plans, maxUses, expiresAt }, planKeys) {
  code = String(code || '').trim();
  if (!CODE_RE.test(code)) throw bad('Code: 3 to 20 letters, numbers, - or _ (no spaces)');
  percent = Math.floor(Number(percent));
  if (!(percent >= 1 && percent <= 100)) throw bad('Discount must be between 1 and 100 percent');
  const list = (Array.isArray(plans) ? plans : []).filter(k => planKeys.includes(k));
  const max = maxUses === '' || maxUses == null ? null : Math.floor(Number(maxUses));
  if (max !== null && !(max >= 1)) throw bad('Maximum uses must be 1 or more, or left empty');
  let exp = null;
  if (expiresAt) {
    const d = new Date(String(expiresAt).length === 10 ? expiresAt + 'T23:59:59' : expiresAt);
    if (isNaN(d)) throw bad('That expiry date is not valid');
    exp = d.toISOString();
  }
  if (db.prepare('SELECT 1 FROM promos WHERE code = ? COLLATE NOCASE').get(code)) throw bad('That code already exists', 409);
  db.prepare('INSERT INTO promos (code, percent, plans, max_uses, expires_at) VALUES (?,?,?,?,?)').run(code, percent, list.join(','), max, exp);
}
const list = () => db.prepare('SELECT * FROM promos ORDER BY id DESC LIMIT 200').all().map(row);
const setActive = (id, on) => { if (!db.prepare('UPDATE promos SET active = ? WHERE id = ?').run(on ? 1 : 0, id).changes) throw bad('Promo not found', 404); };
const remove = id => { if (!db.prepare('DELETE FROM promos WHERE id = ?').run(id).changes) throw bad('Promo not found', 404); };

// Checks a code for a user and a plan; returns the promo row or throws a message the user can act on.
function validate(code, planKey, userId) {
  const c = String(code || '').trim();
  const p = CODE_RE.test(c) ? db.prepare('SELECT * FROM promos WHERE code = ? COLLATE NOCASE').get(c) : null;
  if (!p || !p.active) throw bad('That promo code is not valid');
  if (p.expires_at && new Date(p.expires_at) < new Date()) throw bad('That promo code has expired');
  if (p.max_uses !== null && p.used >= p.max_uses) throw bad('That promo code has been fully used');
  if (p.plans && !p.plans.split(',').includes(planKey)) throw bad('That promo code does not apply to this plan');
  if (userId && db.prepare("SELECT 1 FROM payments WHERE user_id = ? AND promo_code = ? COLLATE NOCASE AND status = 'success'").get(userId, p.code)) throw bad('You have already used this promo code');
  return p;
}

module.exports = { create, list, setActive, remove, validate };
