// Premium subscriptions. Money is handled by Paystack; we only ever trust Paystack's own verify call (or a correctly
// signed webhook), never the browser, before giving anyone premium.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const posts = require('./posts');

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
const daysLeft = key => Math.max(1, Math.ceil((planEnd(key) - Date.now()) / 86400000));
const PLAN_TEXT = { daily: 'until midnight tonight', weekly: 'Monday to Sunday', monthly: '30 days' };
const isActive = u => !!(u && u.premium_until && new Date(u.premium_until) > new Date());

function status(user) {
  return { active: isActive(user), until: user && user.premium_until && isActive(user) ? user.premium_until : null };
}

// What the apps need to show the upgrade screen.
function offer() {
  return { enabled: enabled(), currency: config.paystack.currency, endsAt: weekEnd().toISOString(), daysLeft: daysLeft('weekly'), plans: plans().map(({ key, name, price }) => ({ key, name, price, endsAt: planEnd(key).toISOString(), days: daysLeft(key), text: PLAN_TEXT[key] || '' })) };
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

// Step 1: create a pending payment and get Paystack's checkout address.
async function checkout(user, planKey, { email, callbackUrl }) {
  if (!enabled()) throw Object.assign(new Error('Payments are not switched on yet. Please check back soon.'), { status: 503 });
  const plan = planOf(planKey) || plans()[0];
  if (!plan) throw Object.assign(new Error('Choose a plan'), { status: 400 });
  const reference = 'OD-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  const amount = toMinor(plan.price);
  const data = await paystack('POST', '/transaction/initialize', {
    email: validEmail(email) || `${user.phone}@pawaodds.app`,
    amount, currency: config.paystack.currency, reference,
    callback_url: callbackUrl || undefined,
    metadata: { user_id: user.id, plan: plan.key, custom_fields: [{ display_name: 'Plan', variable_name: 'plan', value: `${plan.name} (${PLAN_TEXT[plan.key] || ''})` }] },
  });
  db.prepare('INSERT INTO payments (reference, user_id, plan, days, amount, currency) VALUES (?,?,?,?,?,?)')
    .run(reference, user.id, plan.key, daysLeft(plan.key), amount, config.paystack.currency);
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
    const u = db.prepare('SELECT premium_until FROM users WHERE id = ?').get(pay.user_id);
    const end = new Date(planEnd(pay.plan).getTime() - 1000), cur = u && u.premium_until ? new Date(u.premium_until) : null;
    db.prepare('UPDATE users SET premium_until = ? WHERE id = ?').run((cur && cur > end ? cur : end).toISOString(), pay.user_id);
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

function summary() {
  const now = new Date().toISOString();
  const active = db.prepare('SELECT COUNT(*) c FROM users WHERE premium_until > ?').get(now).c;
  const sum = days => db.prepare("SELECT COALESCE(SUM(amount),0) a, COUNT(*) n FROM payments WHERE status = 'success' AND paid_at >= ?").get(new Date(Date.now() - days * 86400000).toISOString());
  const recent = db.prepare(`SELECT p.reference, p.plan, p.amount, p.currency, p.channel, p.paid_at, u.phone FROM payments p JOIN users u ON u.id = p.user_id
    WHERE p.status = 'success' ORDER BY p.paid_at DESC LIMIT 10`).all();
  return { active, week: sum(7), month: sum(30), recent, currency: config.paystack.currency, enabled: enabled() };
}

module.exports = { enabled, offer, status, isActive, checkout, verify, grant, webhookValid, summary };
