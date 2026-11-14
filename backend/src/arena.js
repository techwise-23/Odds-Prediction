// Arena Picks: the coin wallet and the games' results live on the server, so a coin can only be had by buying it,
// claiming the daily bonus or winning it. Coins have no cash value: they cannot be withdrawn or exchanged for anything.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const premium = require('./premium');

const A = config.arena;
const STAKES = [50, 100, 250, 500];
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);

// ---- wallet
const ensure = db.transaction(userId => {
  let w = db.prepare('SELECT * FROM arena_wallets WHERE user_id = ?').get(userId);
  if (!w) {
    db.prepare('INSERT INTO arena_wallets (user_id, coins) VALUES (?, ?)').run(userId, A.welcomeCoins);
    db.prepare("INSERT INTO arena_tx (user_id, kind, delta, note) VALUES (?, 'Welcome gift', ?, 'Free starting coins')").run(userId, A.welcomeCoins);
    w = db.prepare('SELECT * FROM arena_wallets WHERE user_id = ?').get(userId);
  }
  return w;
});
const change = (userId, delta, kind, note) => {
  db.prepare('UPDATE arena_wallets SET coins = coins + ? WHERE user_id = ?').run(delta, userId);
  if (kind) db.prepare('INSERT INTO arena_tx (user_id, kind, delta, note) VALUES (?,?,?,?)').run(userId, kind, delta, note || null);
  return db.prepare('SELECT coins FROM arena_wallets WHERE user_id = ?').get(userId).coins;
};

function boughtToday(userId) { // whole units paid (or being paid) today
  const r = db.prepare("SELECT COALESCE(SUM(amount),0) a FROM arena_orders WHERE user_id = ? AND (status = 'success' OR created_at >= datetime('now','-1 hour')) AND created_at >= datetime('now','start of day')").get(userId);
  return r.a / 100;
}

function wallet(userId) {
  const w = ensure(userId), can = w.bonus_day !== today();
  const streak = w.bonus_day === yesterday() ? w.streak : w.bonus_day === today() ? w.streak : 0;
  return {
    coins: w.coins, currency: config.paystack.currency, enabled: premium.enabled(),
    bonus: { can, amount: A.dailyBonus, streak },
    packs: A.packs.map(price => ({ price, coins: Math.round(price * A.coinsPerUnit) })), coinsPerUnit: A.coinsPerUnit,
    limit: { daily: A.dailyLimit, left: Math.max(0, A.dailyLimit - boughtToday(userId)) },
    tx: db.prepare('SELECT kind, delta, note, created_at FROM arena_tx WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(userId),
  };
}

const claimBonus = db.transaction(userId => {
  const w = ensure(userId);
  if (w.bonus_day === today()) throw fail('You already claimed today. Come back tomorrow.', 409);
  const streak = w.bonus_day === yesterday() ? w.streak + 1 : 1;
  db.prepare('UPDATE arena_wallets SET bonus_day = ?, streak = ? WHERE user_id = ?').run(today(), streak, userId);
  return { coins: change(userId, A.dailyBonus, 'Daily bonus', `Day ${streak} streak`), streak };
});

// ---- games. The server draws the result; the page only animates it.
const rint = n => crypto.randomInt(n);
const SEG = ['R','X','B','H','R','X','G','R','A','X','R','B','H','X','R','G','X','R','B','R'];
const PAY = { R: 1, B: 4, G: 6, A: 14, X: 0, H: 0.5 };
const MUL = SEG.map((k, i) => k === 'R' ? ([7, 17].includes(i) ? 2 : 1) : PAY[k]);

const spin = db.transaction((userId, picks, stake) => {
  picks = [...new Set(Array.isArray(picks) ? picks.map(String) : [])];
  if (!picks.length || picks.length > 4 || picks.some(k => !['R','B','G','A'].includes(k))) throw fail('Pick between one and four colours');
  if (!STAKES.includes(Number(stake))) throw fail('Choose a stake from the list');
  stake = Number(stake);
  const w = ensure(userId), total = stake * picks.length;
  if (w.coins < total) throw fail('Not enough coins: lower the stake or drop a colour');
  const win = rint(20), k = SEG[win], hit = picks.includes(k);
  const net = k === 'H' ? -Math.round(total / 2) : (hit ? stake * MUL[win] : 0) - stake * (picks.length - (hit ? 1 : 0));
  const coins = change(userId, net);
  db.prepare('INSERT INTO arena_rounds (user_id, game, stake, detail, net) VALUES (?,?,?,?,?)').run(userId, 'Spin', total, JSON.stringify({ picks, win, k }), net);
  return { win, k, net, coins };
});

const race = db.transaction((userId, pick, stake) => {
  if (!['A','B','D'].includes(pick)) throw fail('Pick Car A, Car B or Draw');
  if (!STAKES.includes(Number(stake))) throw fail('Choose a stake from the list');
  stake = Number(stake);
  const w = ensure(userId);
  if (w.coins < stake) throw fail('Not enough coins: lower the stake');
  const x = rint(100), r = x < 45 ? 'A' : x < 90 ? 'B' : 'D';
  const net = r === 'D' ? (pick === 'D' ? stake * 4 : 0) : (pick === r ? stake : -stake);
  const coins = change(userId, net);
  db.prepare('INSERT INTO arena_rounds (user_id, game, stake, detail, net) VALUES (?,?,?,?,?)').run(userId, 'Race', stake, JSON.stringify({ pick, r }), net);
  return { r, net, coins };
});

// ---- leaderboard: richest players, names masked
const mask = phone => { const p = String(phone).replace(/\D/g, ''); if (p.length < 6) return 'Player'; const t = '0' + p.slice(-9); return t.slice(0, 3) + ' ••• ' + t.slice(-4); };
function leaders(userId) {
  const rows = db.prepare(`SELECT w.user_id, w.coins, u.phone,
      COALESCE((SELECT SUM(net) FROM arena_rounds r WHERE r.user_id = w.user_id), 0) pl,
      COALESCE((SELECT COUNT(*) FROM arena_rounds r WHERE r.user_id = w.user_id), 0) rounds,
      COALESCE((SELECT MAX(net) FROM arena_rounds r WHERE r.user_id = w.user_id), 0) best
    FROM arena_wallets w JOIN users u ON u.id = w.user_id WHERE u.blocked = 0 ORDER BY w.coins DESC LIMIT 20`).all();
  return rows.map(r => ({ name: mask(r.phone), coins: r.coins, pl: r.pl, rounds: r.rounds, best: r.best, me: r.user_id === userId }));
}

// ---- buying coins with Paystack
async function buy(user, price, { email, callbackUrl } = {}) {
  if (!premium.enabled()) throw fail('Payments are not switched on yet. Please check back soon.', 503);
  price = Number(price);
  if (!A.packs.includes(price)) throw fail('Choose one of the coin packs');
  ensure(user.id);
  if (boughtToday(user.id) + price > A.dailyLimit) throw fail(`The daily limit is ${config.paystack.currency} ${A.dailyLimit}. Please come back tomorrow.`, 429);
  const reference = 'AC-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  const coins = Math.round(price * A.coinsPerUnit), amount = premium.toMinor(price);
  const data = await premium.paystack('POST', '/transaction/initialize', {
    email: premium.validEmail(email) || `${user.phone}@pawaodds.app`, amount, currency: config.paystack.currency, reference,
    callback_url: callbackUrl || undefined,
    metadata: { user_id: user.id, kind: 'arena-coins', coins, custom_fields: [{ display_name: 'Arena Picks coins', variable_name: 'coins', value: String(coins) }] },
  });
  db.prepare('INSERT INTO arena_orders (reference, user_id, amount, coins, currency) VALUES (?,?,?,?,?)').run(reference, user.id, amount, coins, config.paystack.currency);
  return { reference, url: data.authorization_url };
}

// Credits the coins once per payment, even if the browser, the webhook and the safety net all arrive.
const grant = db.transaction((reference, channel) => {
  const o = db.prepare('SELECT * FROM arena_orders WHERE reference = ?').get(reference);
  if (!o) return null;
  const done = db.prepare("UPDATE arena_orders SET status = 'success', paid_at = ?, channel = ? WHERE reference = ? AND status != 'success'").run(new Date().toISOString(), channel || null, reference).changes;
  if (done) { ensure(o.user_id); change(o.user_id, o.coins, 'Bought coins', `${config.paystack.currency} ${(o.amount / 100).toLocaleString()} via ${channel || 'Paystack'}`); }
  return o;
});

async function verify(reference) {
  reference = String(reference || '');
  const o = db.prepare('SELECT * FROM arena_orders WHERE reference = ?').get(reference);
  if (!o) throw fail('Payment not found', 404);
  if (o.status === 'success') return { paid: true };
  const t = await premium.paystack('GET', '/transaction/verify/' + encodeURIComponent(reference));
  if (t.status !== 'success') return { paid: false, state: t.status };
  if (t.amount !== o.amount || String(t.currency).toUpperCase() !== o.currency) {
    console.error(`Paystack amount mismatch for ${reference}: got ${t.amount} ${t.currency}, expected ${o.amount} ${o.currency}`);
    throw fail('The amount paid does not match this pack. Contact support with your payment reference ' + reference, 409);
  }
  grant(reference, t.channel);
  return { paid: true };
}

async function reconcile() {
  if (!premium.enabled()) return;
  for (const p of db.prepare("SELECT reference FROM arena_orders WHERE status != 'success' AND created_at <= datetime('now','-3 minutes') AND created_at >= datetime('now','-3 days') ORDER BY rowid DESC LIMIT 25").all()) {
    try { await verify(p.reference); } catch { /* try again next time */ }
  }
}

module.exports = { wallet, claimBonus, spin, race, leaders, buy, verify, reconcile, STAKES };
