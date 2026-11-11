// Growth numbers for the admin: sign-ups, the path from sign-up to paying, revenue by day, and which codes bring sales.
const db = require('./db');

const TRACKED = ['pay_view']; // what the apps may report (everything else is already in the users and payments tables)
function track(userId, kind) {
  if (!TRACKED.includes(kind)) throw Object.assign(new Error('Unknown event'), { status: 400 });
  // One row per user per kind per day is plenty for a funnel.
  if (db.prepare("SELECT 1 FROM events WHERE user_id = ? AND kind = ? AND created_at >= datetime('now','-1 day')").get(userId, kind)) return;
  db.prepare('INSERT INTO events (user_id, kind) VALUES (?,?)').run(userId, kind);
}

function report(days = 30) {
  days = Math.min(Math.max(Math.floor(Number(days)) || 30, 1), 365);
  const since = `datetime('now','-${days} days')`;
  const one = sql => db.prepare(sql).get().n;
  const funnel = {
    signups: one(`SELECT COUNT(*) n FROM users WHERE created_at >= ${since}`),
    sawPay: one(`SELECT COUNT(DISTINCT e.user_id) n FROM events e JOIN users u ON u.id = e.user_id WHERE e.kind = 'pay_view' AND u.created_at >= ${since}`),
    startedCheckout: one(`SELECT COUNT(DISTINCT p.user_id) n FROM payments p JOIN users u ON u.id = p.user_id WHERE u.created_at >= ${since}`),
    paid: one(`SELECT COUNT(DISTINCT p.user_id) n FROM payments p JOIN users u ON u.id = p.user_id WHERE p.status = 'success' AND u.created_at >= ${since}`),
  };
  const signups = db.prepare(`SELECT date(created_at) d, COUNT(*) n FROM users WHERE created_at >= ${since} GROUP BY d`).all();
  const revenue = db.prepare(`SELECT date(paid_at) d, COUNT(*) n, SUM(amount) a FROM payments WHERE status = 'success' AND paid_at >= ${since} GROUP BY d`).all();
  const byDay = {};
  for (let i = days - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); byDay[d] = { d, signups: 0, sales: 0, amount: 0 }; }
  for (const r of signups) if (byDay[r.d]) byDay[r.d].signups = r.n;
  for (const r of revenue) if (byDay[r.d]) { byDay[r.d].sales = r.n; byDay[r.d].amount = r.a; }
  const promos = db.prepare(`SELECT promo_code code, COUNT(*) n, SUM(amount) a FROM payments WHERE status = 'success' AND promo_code IS NOT NULL AND paid_at >= ${since} GROUP BY promo_code ORDER BY n DESC LIMIT 10`).all();
  const plans = db.prepare(`SELECT plan, COUNT(*) n, SUM(amount) a FROM payments WHERE status = 'success' AND paid_at >= ${since} GROUP BY plan ORDER BY n DESC`).all();
  const referrals = db.prepare(`SELECT COUNT(*) joined, SUM(ref_qualified_at IS NOT NULL) bought FROM users WHERE referred_by IS NOT NULL AND created_at >= ${since}`).get();
  return { days, funnel, daily: Object.values(byDay), promos, plans, referrals: { joined: referrals.joined || 0, bought: referrals.bought || 0 } };
}

module.exports = { track, report };
