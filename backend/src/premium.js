// Premium subscriptions. Money is handled by Paystack; we only ever trust Paystack's own verify call (or a correctly
// signed webhook), never the browser, before giving anyone premium.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const posts = require('./posts');
const promos = require('./promos');

const plans = () => config.premiumPlans.filter(p => p.price > 0);
const planOf = key => plans().find(p => p.key === key);
const enabled = () => !!config.paystack.secret;
const toMinor = price => Math.round(price * 100);
// The pass runs Monday to Sunday: it ends at the start of the next Monday (app time zone).
function weekEnd() {
  const today = posts.localDate(0), dow = new Date(today + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
  return posts.zonedInstant(posts.addDays(today, (7 - dow) % 7 + 1), 0);
}
// When a pass bought now stops working.
function planEnd(key) {
  if (key === 'daily') return posts.zonedInstant(posts.addDays(posts.localDate(0), 1), 0);
  if (key === 'monthly') return new Date(Date.now() + 30 * 86400000);
  return weekEnd();
}
const DURATION = { daily: 1, weekly: 7, monthly: 30 }; // days added when a pass is bought while one is still running
// When a pass bought now stops working. Buying while a pass is still running adds the plan's length on top, so renewing early never wastes days.
function endFor(user, key) {
  if (isActive(user)) return new Date(new Date(user.premium_until).getTime() + (DURATION[key] || 7) * 86400000);
  return planEnd(key);
}
const daysLeft = (key, user) => Math.max(1, Math.ceil((endFor(user, key) - Date.now()) / 86400000));
const PLAN_TEXT = { daily: 'until midnight tonight', weekly: 'Monday to Sunday', monthly: '30 days' };
const isActive = u => !!(u && u.premium_until && new Date(u.premium_until) > new Date());

// How long before the end of a pass we start asking people to renew (a daily pass: only the last few hours).
function warnHours(userId) {
  const last = db.prepare("SELECT plan FROM payments WHERE user_id = ? AND status = 'success' ORDER BY paid_at DESC LIMIT 1").get(userId);
  return last && last.plan === 'daily' ? 5 : 24;
}
function status(user) {
  const active = isActive(user), hoursLeft = active ? (new Date(user.premium_until) - Date.now()) / 3600000 : null;
  return { active, until: active ? user.premium_until : null, endsSoon: active && hoursLeft <= warnHours(user.id) };
}

// What the apps need to show the upgrade screen.
function offer(user) {
  return { enabled: enabled(), currency: config.paystack.currency, endsAt: endFor(user, 'weekly').toISOString(), daysLeft: daysLeft('weekly', user), plans: plans().map(({ key, name, price }) => ({ key, name, price, endsAt: endFor(user, key).toISOString(), days: daysLeft(key, user), text: PLAN_TEXT[key] || '' })) };
}

async function paystack(method, path, body) {
  let res;
  try {
    res = await fetch(config.paystack.api + path, {
      method, headers: { Authorization: 'Bearer ' + config.paystack.secret, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
    });
  } catch { throw Object.assign(new Error('Could not reach Paystack. Try again in a moment.'), { status: 502 }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) throw Object.assign(new Error(data.message || 'Paystack rejected the request'), { status: 502 });
  return data.data;
}

const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim()) ? String(v).trim().toLowerCase() : '';

// What a plan costs after an optional promo code, in pesewas.
const discounted = (plan, promo) => promo ? Math.round(toMinor(plan.price) * (100 - promo.percent) / 100) : toMinor(plan.price);

// For the promo box: the price of every plan this code applies to.
function promoPreview(user, code) {
  const out = {};
  let first = null, firstErr = null;
  for (const plan of plans()) {
    try { const p = promos.validate(code, plan.key, user.id); first = p; out[plan.key] = { original: plan.price, price: discounted(plan, p) / 100 }; }
    catch (e) { firstErr = firstErr || e; }
  }
  if (!first) throw firstErr || Object.assign(new Error('That promo code is not valid'), { status: 400 });
  return { code: first.code, percent: first.percent, plans: out };
}

// Step 1: create a pending payment and get Paystack's checkout address.
async function checkout(user, planKey, { email, callbackUrl, promo: promoCode }) {
  if (!enabled()) throw Object.assign(new Error('Payments are not switched on yet. Please check back soon.'), { status: 503 });
  const plan = planOf(planKey) || plans()[0];
  if (!plan) throw Object.assign(new Error('Choose a plan'), { status: 400 });
  const promo = promoCode ? promos.validate(promoCode, plan.key, user.id) : null;
  const reference = 'OD-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  const amount = discounted(plan, promo), days = daysLeft(plan.key, user);
  const save = () => db.prepare('INSERT INTO payments (reference, user_id, plan, days, amount, currency, promo_code, list_amount) VALUES (?,?,?,?,?,?,?,?)')
    .run(reference, user.id, plan.key, days, amount, config.paystack.currency, promo ? promo.code : null, toMinor(plan.price));
  if (amount <= 0) { save(); grant(reference, 'promo'); return { reference, free: true }; } // a 100% code: nothing to pay
  const data = await paystack('POST', '/transaction/initialize', {
    email: validEmail(email) || `${user.phone}@pawaodds.app`,
    amount, currency: config.paystack.currency, reference,
    callback_url: callbackUrl || undefined,
    metadata: { user_id: user.id, plan: plan.key, promo: promo ? promo.code : undefined, custom_fields: [{ display_name: 'Plan', variable_name: 'plan', value: `${plan.name} (${PLAN_TEXT[plan.key] || ''})${promo ? ' with code ' + promo.code : ''}` }] },
  });
  save();
  return { reference, url: data.authorization_url };
}

// Gives the days once per payment, even if the browser and the webhook both arrive.
const grant = db.transaction((reference, channel) => {
  const pay = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (!pay) return null;
  const done = db.prepare("UPDATE payments SET status = 'success', paid_at = ?, channel = ? WHERE reference = ? AND status != 'success'")
    .run(new Date().toISOString(), channel || null, reference).changes;
  if (done) {
    // Access lasts as long as the plan says (a later payment never shortens an existing pass).
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(pay.user_id);
    const end = new Date(endFor(u, pay.plan).getTime() - (isActive(u) ? 0 : 1000));
    db.prepare('UPDATE users SET premium_until = ? WHERE id = ?').run(end.toISOString(), pay.user_id);
    if (pay.promo_code) db.prepare('UPDATE promos SET used = used + 1 WHERE code = ? COLLATE NOCASE').run(pay.promo_code);
    require('./referrals').onPurchase(pay.user_id, pay.plan); // may earn the person who referred them free access
  }
  return { ...pay, newlyPaid: !!done };
});

// Step 2: ask Paystack whether the payment really succeeded, and for the right amount.
async function verify(reference) {
  reference = String(reference || '');
  const pay = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (!pay) throw Object.assign(new Error('Payment not found'), { status: 404 });
  if (pay.status === 'success') return { paid: true, pay };
  const t = await paystack('GET', '/transaction/verify/' + encodeURIComponent(reference));
  if (t.status !== 'success') return { paid: false, state: t.status, pay };
  if (t.amount !== pay.amount || String(t.currency).toUpperCase() !== pay.currency) {
    console.error(`Paystack amount mismatch for ${reference}: got ${t.amount} ${t.currency}, expected ${pay.amount} ${pay.currency}`);
    throw Object.assign(new Error('The amount paid does not match this plan. Contact support with your payment reference ' + reference), { status: 409 });
  }
  return { paid: true, pay: grant(reference, t.channel) };
}

// Paystack calls this itself when a payment succeeds, so users still get access if they close the page early.
function webhookValid(rawBody, signature) {
  if (!enabled() || !rawBody || !signature) return false;
  const mine = crypto.createHmac('sha512', config.paystack.secret).update(rawBody).digest('hex');
  const a = Buffer.from(mine), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Safety net: a payment Paystack confirmed but whose customer never came back (and whose webhook never arrived) is
// re-checked every few minutes for 3 days, and unlocks by itself.
let reconciling = false;
async function reconcile() {
  if (!enabled() || reconciling) return { checked: 0, unlocked: 0 };
  reconciling = true;
  let checked = 0, unlocked = 0;
  try {
    for (const p of db.prepare("SELECT reference FROM payments WHERE status != 'success' AND created_at <= datetime('now','-3 minutes') AND created_at >= datetime('now','-3 days') ORDER BY rowid DESC LIMIT 25").all()) {
      checked++;
      try { const r = await verify(p.reference); if (r.paid) unlocked++; } catch (e) { if (e.status === 409) console.error('reconcile:', e.message); /* Paystack unreachable or not found: try again next time */ }
    }
  } finally { reconciling = false; }
  if (unlocked) console.log(`Payments: unlocked ${unlocked} late payment(s)`);
  return { checked, unlocked };
}

// Admin list: newest first, optionally only unpaid ones.
function listPayments({ status, limit = 100 } = {}) {
  const where = status === 'pending' ? "WHERE p.status != 'success'" : status === 'success' ? "WHERE p.status = 'success'" : '';
  return db.prepare(`SELECT p.reference, p.plan, p.amount, p.currency, p.status, p.channel, p.promo_code, p.created_at, p.paid_at, u.phone FROM payments p
    JOIN users u ON u.id = p.user_id ${where} ORDER BY p.rowid DESC LIMIT ?`).all(Math.min(Number(limit) || 100, 300));
}

// Admin override for a customer who paid but whose payment never confirmed (checked by hand against Paystack's dashboard).
function manualUnlock(reference) {
  const pay = db.prepare('SELECT status FROM payments WHERE reference = ?').get(String(reference || ''));
  if (!pay) throw Object.assign(new Error('Payment not found'), { status: 404 });
  if (pay.status === 'success') throw Object.assign(new Error('That payment is already unlocked'), { status: 409 });
  return grant(reference, 'manual');
}

function summary() {
  const now = new Date().toISOString();
  const active = db.prepare('SELECT COUNT(*) c FROM users WHERE premium_until > ?').get(now).c;
  const sum = days => db.prepare("SELECT COALESCE(SUM(amount),0) a, COUNT(*) n FROM payments WHERE status = 'success' AND paid_at >= ?").get(new Date(Date.now() - days * 86400000).toISOString());
  const recent = db.prepare(`SELECT p.reference, p.plan, p.amount, p.currency, p.channel, p.paid_at, u.phone FROM payments p JOIN users u ON u.id = p.user_id
    WHERE p.status = 'success' ORDER BY p.paid_at DESC LIMIT 10`).all();
  return { active, week: sum(7), month: sum(30), recent, currency: config.paystack.currency, enabled: enabled() };
}

module.exports = { reconcile, listPayments, manualUnlock, promoPreview, enabled, offer, status, isActive, checkout, verify, grant, webhookValid, summary };
