// Public app: daily picks, tickets, dashboard, record and the user's slip.
const express = require('express');
const config = require('../config');
const db = require('../db');
const engine = require('../engine');
const { auth, authAny } = require('../middleware/auth');
const posts = require('../posts');
const premium = require('../premium');
const { predictionRows, ticketsFor } = require('../services/tickets');

const router = express.Router();

// Booking codes posted by the admin. Expired posts are never returned.
router.get('/posts', auth, (req, res) => {
  res.json({ posts: posts.active({ premium: premium.isActive(req.user) }), premium: { ...premium.status(req.user), ...premium.offer() }, platforms: config.platforms.map(({ key, name, url }) => ({ key, name, url })), now: new Date().toISOString() });
});
// Screenshot of a booking slip. Needs a signed-in user (or admin); the page fetches it with its token and shows it.
router.get('/post-images/:id', authAny, (req, res) => {
  const img = /^[0-9a-f]{32}$/.test(req.params.id) ? posts.image(req.params.id) : null;
  if (!img) return res.status(404).json({ error: 'Not found' });
  if (posts.imageIsPremium(req.params.id) && !req.isAdmin && !premium.isActive(req.user)) return res.status(403).json({ error: 'Premium members only' });
  res.set({ 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' }).send(img.data);
});

router.get('/predictions', auth, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : engine.localDate(0);
  const rows = predictionRows('p.date = ? ORDER BY f.kickoff, f.league_name', [date]);
  const saved = new Set(db.prepare('SELECT prediction_id FROM user_picks WHERE user_id = ?').all(req.user.id).map(r => r.prediction_id));
  const tiers = { low: [], medium: [], high: [] };
  for (const r of rows) tiers[r.tier].push({ ...r, saved: saved.has(r.id) });

  const accas = ticketsFor(date).map(a => ({ ...a, legs: a.legs.map(r => ({ ...r, saved: saved.has(r.id) })) }));
  res.json({ date, demo: !config.apiKey, tiers, accas, tierInfo: config.tiers, platforms: config.platforms });
});

// Everything the home dashboard needs in one call.
router.get('/dashboard', auth, (req, res) => {
  const nowIso = new Date().toISOString();
  const today = engine.localDate(0), tomorrow = engine.localDate(1);
  const notStarted = p => p.status === 'NS' && p.kickoff > nowIso;

  // Focus on today, or tomorrow once every game today has kicked off.
  let date = today, picks = predictionRows('p.date = ? ORDER BY f.kickoff', [today]);
  if (!picks.some(notStarted)) {
    const t = predictionRows('p.date = ? ORDER BY f.kickoff', [tomorrow]);
    if (t.length) { date = tomorrow; picks = t; }
  }
  const saved = new Set(db.prepare('SELECT prediction_id FROM user_picks WHERE user_id = ?').all(req.user.id).map(r => r.prediction_id));
  const open = picks.filter(notStarted);

  // Pick of the day: best balance of chance and price among low/medium picks.
  const pickOfDay = open.filter(p => p.tier !== 'high')
    .sort((a, b) => b.probability * Math.sqrt(b.odds) - a.probability * Math.sqrt(a.odds))[0] || null;

  const next = db.prepare(`SELECT f.kickoff, f.home, f.away, f.league_name FROM fixtures f
    WHERE f.kickoff > ? AND f.status = 'NS' AND EXISTS (SELECT 1 FROM predictions p WHERE p.fixture_id = f.id)
    ORDER BY f.kickoff LIMIT 1`).get(nowIso) || null;

  const hit = db.prepare(`SELECT tier, SUM(result='won') won, SUM(result='lost') lost FROM predictions
    WHERE date >= date('now','-30 day') GROUP BY tier`).all();
  const tiers = Object.keys(config.tiers).map(k => {
    const list = picks.filter(p => p.tier === k), h = hit.find(x => x.tier === k) || { won: 0, lost: 0 };
    return {
      key: k, label: config.tiers[k].label, min: config.tiers[k].min, max: config.tiers[k].max,
      count: list.length, open: list.filter(notStarted).length,
      bestOdds: list.length ? Math.max(...list.map(p => p.odds)) : null,
      won: h.won, lost: h.lost, hitRate: h.won + h.lost ? h.won / (h.won + h.lost) : null,
    };
  });

  const tickets = ticketsFor(date).map(a => ({
    id: a.id, key: a.key, grp: a.grp, name: a.name, total_odds: a.total_odds, probability: a.probability,
    result: a.result, codes: a.codes, legs: a.legs.length,
    started: a.legs.filter(l => !notStarted(l)).length,
    won: a.legs.filter(l => l.result === 'won').length,
    firstKickoff: a.legs.map(l => l.kickoff).sort()[0],
  }));

  // Games that have kicked off today, with how our picks on them did.
  const games = new Map();
  for (const p of predictionRows('p.date = ? ORDER BY f.kickoff DESC', [today])) {
    if (notStarted(p)) continue;
    const g = games.get(p.fixture_id) || { id: p.fixture_id, home: p.home, away: p.away, league: p.league_name, kickoff: p.kickoff,
      status: p.status, home_goals: p.home_goals, away_goals: p.away_goals, won: 0, lost: 0, pending: 0 };
    g[p.result === 'won' ? 'won' : p.result === 'lost' ? 'lost' : 'pending']++;
    games.set(p.fixture_id, g);
  }

  const form = db.prepare(`SELECT p.result, p.tier, p.odds, f.home, f.away FROM predictions p JOIN fixtures f ON f.id = p.fixture_id
    WHERE p.result IN ('won','lost') ORDER BY f.kickoff DESC, p.id DESC LIMIT 20`).all();
  const days = db.prepare(`SELECT date, SUM(result='won') won, SUM(result='lost') lost FROM predictions
    WHERE result IN ('won','lost') GROUP BY date ORDER BY date DESC LIMIT 14`).all().reverse();
  const lowRuns = db.prepare(`SELECT p.result FROM predictions p JOIN fixtures f ON f.id = p.fixture_id
    WHERE p.tier = 'low' AND p.result IN ('won','lost') ORDER BY f.kickoff DESC LIMIT 200`).all();
  let streak = 0; for (const r of lowRuns) { if (r.result !== 'won') break; streak++; }

  const slip = predictionRows('p.id IN (SELECT prediction_id FROM user_picks WHERE user_id = ?)', [req.user.id]).filter(notStarted);

  res.json({
    date, isToday: date === today, now: nowIso, demo: !config.apiKey, platforms: config.platforms,
    totals: { games: new Set(picks.map(p => p.fixture_id)).size, picks: picks.length, open: open.length },
    next, pickOfDay: pickOfDay && { ...pickOfDay, saved: saved.has(pickOfDay.id) },
    tiers, tickets, live: [...games.values()].slice(0, 12), form, days, lowStreak: streak,
    slip: { count: slip.length, totalOdds: slip.reduce((x, p) => x * p.odds, 1) },
  });
});

router.get('/stats', auth, (req, res) => {
  const tiers = db.prepare(`SELECT tier, SUM(result='won') won, SUM(result='lost') lost,
      ROUND(AVG(CASE WHEN result IN ('won','lost') THEN odds END), 2) avg_odds,
      ROUND(SUM(CASE WHEN result='won' THEN odds - 1 WHEN result='lost' THEN -1 ELSE 0 END), 2) profit
    FROM predictions WHERE date >= date('now','-30 day') GROUP BY tier`).all();
  const accas = db.prepare(`SELECT name, SUM(result='won') won, SUM(result='lost') lost FROM accas
    WHERE date >= date('now','-30 day') GROUP BY key ORDER BY MIN(total_odds)`).all();
  const recent = db.prepare(`SELECT date, SUM(result='won') won, SUM(result='lost') lost FROM predictions
    WHERE result IN ('won','lost') GROUP BY date ORDER BY date DESC LIMIT 14`).all();
  res.json({ tiers, accas, recent });
});

// ---------- user slip ----------
router.get('/slip', auth, (req, res) => {
  const rows = predictionRows('p.id IN (SELECT prediction_id FROM user_picks WHERE user_id = ?) ORDER BY f.kickoff DESC', [req.user.id]);
  res.json({ picks: rows });
});

function addToSlip(userId, predId) {
  const p = db.prepare(`SELECT p.id, f.kickoff, f.status FROM predictions p JOIN fixtures f ON f.id = p.fixture_id WHERE p.id = ?`).get(predId);
  if (!p) return 'Pick not found';
  if (new Date(p.kickoff) <= new Date() || p.status !== 'NS') return 'That game has already started';
  db.prepare('INSERT OR IGNORE INTO user_picks (user_id, prediction_id) VALUES (?,?)').run(userId, predId);
  return null;
}

router.post('/slip', auth, (req, res) => {
  const err = addToSlip(req.user.id, Number(req.body.predictionId));
  err ? res.status(400).json({ error: err }) : res.json({ ok: true });
});
router.post('/slip/acca/:id', auth, (req, res) => {
  const legs = db.prepare('SELECT prediction_id FROM acca_legs WHERE acca_id = ?').all(Number(req.params.id));
  let added = 0;
  for (const l of legs) if (!addToSlip(req.user.id, l.prediction_id)) added++;
  res.json({ ok: true, added });
});
router.delete('/slip/:predictionId', auth, (req, res) => {
  db.prepare('DELETE FROM user_picks WHERE user_id = ? AND prediction_id = ?').run(req.user.id, Number(req.params.predictionId));
  res.json({ ok: true });
});


module.exports = router;
