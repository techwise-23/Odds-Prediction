// Daily prediction engine: fetch games -> model -> pick low/medium/high odds -> build accumulators.
const db = require('./db');
const config = require('./config');
const providers = require('./providers');
const { expectedGoals, marketProbabilities, blendWithMarket, settlePick, chooseLegs, PICKS } = require('./model');

// "YYYY-MM-DD" for a date in the app's time zone, offset by N days.
function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function confidenceStars(prob, tier) {
  const t = config.tiers[tier];
  const top = Math.min(0.95, 1 / t.min);
  const x = Math.max(0, Math.min(1, (prob - t.minProb) / (top - t.minProb)));
  return Math.max(1, Math.min(5, Math.round(1 + x * 4)));
}

// Choose the best pick for one fixture inside one odds band.
function bestPickForTier(probs, odds, tierKey) {
  const t = config.tiers[tierKey];
  // How much the tier values safety (probability) vs. value (edge over the odds).
  const safetyWeight = { low: 1.0, medium: 0.5, high: 0.15 }[tierKey];
  let best = null;
  for (const code of Object.keys(PICKS)) {
    const p = probs[code];
    let o = odds && odds[code], source = 'bookmaker';
    if (!(o > 1)) { o = +(1 / p * 0.93).toFixed(2); source = 'model'; } // fair odds minus a typical margin
    if (o < t.min || o >= t.max || p < t.minProb) continue;
    const edge = p * o - 1;
    if (edge < -0.08) continue; // clearly poor value
    const score = edge + safetyWeight * p;
    if (!best || score > best.score) best = { code, prob: p, odds: o, source, score };
  }
  return best;
}

const upsertFixture = db.prepare(`
  INSERT INTO fixtures (id, date, kickoff, league_id, league_name, league_country, home, away, home_logo, away_logo, status, home_goals, away_goals, exp_home, exp_away)
  VALUES (@id, @date, @kickoff, @league_id, @league_name, @league_country, @home, @away, @home_logo, @away_logo, @status, @home_goals, @away_goals, @exp_home, @exp_away)
  ON CONFLICT(id) DO UPDATE SET kickoff=excluded.kickoff, status=excluded.status, home_goals=excluded.home_goals,
    away_goals=excluded.away_goals, exp_home=excluded.exp_home, exp_away=excluded.exp_away`);

// A pick is locked when a user saved it or it is part of a ticket that has a booking code on any bookmaker.
const findPred = db.prepare(`SELECT p.id,
    (SELECT COUNT(*) FROM user_picks u WHERE u.prediction_id = p.id)
  + (SELECT COUNT(*) FROM acca_legs l JOIN booking_codes b ON b.acca_id = l.acca_id
       WHERE l.prediction_id = p.id) AS locked
  FROM predictions p WHERE fixture_id = ? AND tier = ?`);
const insertPred = db.prepare(`INSERT INTO predictions (fixture_id, date, tier, market, pick, pick_code, odds, odds_source, probability, confidence)
  VALUES (@fixture_id, @date, @tier, @market, @pick, @pick_code, @odds, @odds_source, @probability, @confidence)`);
const updatePred = db.prepare(`UPDATE predictions SET market=@market, pick=@pick, pick_code=@pick_code, odds=@odds, odds_source=@odds_source,
  probability=@probability, confidence=@confidence WHERE id=@id`);
const deletePred = db.prepare('DELETE FROM predictions WHERE id = ?');

async function generateForDate(date, { backfill = false } = {}) {
  const provider = providers.current();
  const { fixtures, strengths, odds } = await provider.getDay(date);
  // Backfill (demo history only) pretends we ran the morning before the games.
  const now = backfill ? new Date(date + 'T00:00:00Z').getTime() : Date.now();
  let made = 0;

  db.transaction(() => {
    for (const f of fixtures) {
      const xg = expectedGoals(strengths[f.league_id], f.home, f.away);
      upsertFixture.run({ ...f, exp_home: xg.home, exp_away: xg.away });
      const started = new Date(f.kickoff).getTime() <= now || f.status !== 'NS';
      if (started) continue; // never change a pick after kick-off

      const probs = blendWithMarket(marketProbabilities(xg.home, xg.away), odds[f.id]);
      for (const tier of Object.keys(config.tiers)) {
        const existing = findPred.get(f.id, tier);
        if (existing && existing.locked > 0) continue; // saved or booked: keep it stable
        const best = bestPickForTier(probs, odds[f.id], tier);
        if (!best) { if (existing) deletePred.run(existing.id); continue; }
        const row = {
          fixture_id: f.id, date, tier, market: PICKS[best.code].market, pick: PICKS[best.code].pick,
          pick_code: best.code, odds: best.odds, odds_source: best.source,
          probability: +best.prob.toFixed(4), confidence: confidenceStars(best.prob, tier),
        };
        if (existing) updatePred.run({ ...row, id: existing.id }); else insertPred.run(row);
        made++;
      }
    }
  })();

  buildAccas(date, now);
  db.prepare('INSERT INTO runs (kind, date, ok, message) VALUES (?,?,?,?)')
    .run('predict', date, 1, `${provider.name}: ${fixtures.length} games, ${made} picks`);
  return { games: fixtures.length, picks: made, provider: provider.name };
}

// Accumulators: greedily add the legs that give the most odds per unit of risk.
function buildAccas(date, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  const preds = db.prepare(`SELECT p.*, f.kickoff FROM predictions p JOIN fixtures f ON f.id = p.fixture_id
    WHERE p.date = ? AND f.kickoff > ? AND f.status = 'NS'`).all(date, now);

  // Tickets that are no longer in config (e.g. after changing the long bets) are removed unless already booked.
  const keys = config.accas.map(a => a.key);
  for (const old of db.prepare('SELECT id, key FROM accas WHERE date = ?').all(date)) {
    if (!keys.includes(old.key) && !db.prepare('SELECT 1 FROM booking_codes WHERE acca_id = ?').get(old.id)) {
      db.prepare('DELETE FROM accas WHERE id = ?').run(old.id);
    }
  }

  for (const spec of config.accas) {
    const existing = db.prepare(`SELECT id, (SELECT COUNT(*) FROM booking_codes b WHERE b.acca_id = accas.id) AS codes
      FROM accas WHERE date = ? AND key = ?`).get(date, spec.key);
    if (existing && existing.codes) continue; // booked on a bookmaker: never rebuild
    if (existing) {
      // Leave a ticket alone once any of its games has started.
      const started = db.prepare(`SELECT COUNT(*) c FROM acca_legs l JOIN predictions p ON p.id = l.prediction_id
        JOIN fixtures f ON f.id = p.fixture_id WHERE l.acca_id = ? AND (f.kickoff <= ? OR f.status != 'NS')`).get(existing.id, now).c;
      if (started) continue;
      db.prepare('DELETE FROM accas WHERE id = ?').run(existing.id);
    }

    const chosen = chooseLegs(preds, spec);
    if (!chosen) continue;
    const { legs, total, prob } = chosen;

    const { lastInsertRowid } = db.prepare('INSERT INTO accas (date, key, grp, name, total_odds, probability) VALUES (?,?,?,?,?,?)')
      .run(date, spec.key, spec.group, spec.name, +total.toFixed(2), +prob.toFixed(5));
    const addLeg = db.prepare('INSERT INTO acca_legs (acca_id, prediction_id) VALUES (?,?)');
    for (const l of legs) addLeg.run(lastInsertRowid, l.id);
  }
}

// Mark finished games, then settle predictions and accumulators.
async function settle() {
  const provider = providers.current();
  const open = db.prepare(`SELECT * FROM fixtures WHERE status NOT IN ('FT','AET','PEN','CANC','ABD','AWD','WO')
    AND kickoff <= ?`).all(new Date(Date.now() - 100 * 60000).toISOString());
  if (!open.length) return { updated: 0 };

  const results = await provider.getResults(open);
  let updated = 0;
  db.transaction(() => {
    for (const r of results) {
      db.prepare('UPDATE fixtures SET status = ?, home_goals = ?, away_goals = ? WHERE id = ?')
        .run(r.status, r.home_goals, r.away_goals, r.id);
      if (providers.FINISHED.includes(r.status)) {
        for (const p of db.prepare("SELECT * FROM predictions WHERE fixture_id = ? AND result = 'pending'").all(r.id)) {
          db.prepare('UPDATE predictions SET result = ? WHERE id = ?').run(settlePick(p.pick_code, r.home_goals, r.away_goals), p.id);
          updated++;
        }
      } else if (providers.VOID.includes(r.status)) {
        db.prepare("UPDATE predictions SET result = 'void' WHERE fixture_id = ? AND result = 'pending'").run(r.id);
      }
    }
    // Accumulators: lost if any leg lost, won when every non-void leg won.
    for (const a of db.prepare("SELECT id FROM accas WHERE result = 'pending'").all()) {
      const legs = db.prepare('SELECT p.result FROM acca_legs l JOIN predictions p ON p.id = l.prediction_id WHERE l.acca_id = ?').all(a.id);
      let res = 'pending';
      if (legs.some(l => l.result === 'lost')) res = 'lost';
      else if (legs.every(l => l.result !== 'pending')) res = legs.some(l => l.result === 'won') ? 'won' : 'void';
      if (res !== 'pending') db.prepare('UPDATE accas SET result = ? WHERE id = ?').run(res, a.id);
    }
  })();
  db.prepare('INSERT INTO runs (kind, ok, message) VALUES (?,?,?)').run('settle', 1, `${updated} picks settled`);
  return { updated };
}

// The daily job: today and tomorrow (tomorrow is refreshed again the next morning).
async function dailyRun() {
  const out = [];
  for (const d of [localDate(0), localDate(1)]) {
    try { out.push({ date: d, ...(await generateForDate(d)) }); }
    catch (e) {
      console.error(`predict ${d}:`, e.message);
      db.prepare('INSERT INTO runs (kind, date, ok, message) VALUES (?,?,?,?)').run('predict', d, 0, e.message);
      out.push({ date: d, error: e.message });
    }
  }
  return out;
}

module.exports = { generateForDate, dailyRun, settle, localDate, buildAccas };
