// In-browser backend for the standalone phone app.
// It answers the same /api/... calls as src/server.js, but keeps all data on the phone
// (localStorage) and uses the built-in demo games. Needs CONFIG, Model and makeDemo (added by the build).
window.LocalAPI = (() => {
  const KEY = 'oddsday-app-v1';
  const { tiers: TIERS, accas: ACCAS, platforms: PLATFORMS, leagues: LEAGUES } = CONFIG;
  const { expectedGoals, marketProbabilities, blendWithMarket, settlePick, chooseLegs, PICKS, buildStrengths, poisson } = Model;
  const provider = makeDemo({ leagues: LEAGUES, buildStrengths, marketProbabilities, poisson });
  const { normalizePhone, displayPhone } = Phone;
  const FINISHED = ['FT', 'AET', 'PEN'];

  // ---------- storage ----------
  let db;
  function fresh() { return { v: 1, seq: 1, users: [], session: null, fixtures: {}, preds: [], accas: [], legs: [], codes: [], picks: [], runs: {} }; }
  function load() {
    try { db = JSON.parse(localStorage.getItem(KEY)); } catch { db = null; }
    if (!db || db.v !== 1) db = fresh();
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* storage full or blocked: keep working in memory */ } }
  const nextId = () => db.seq++;

  // ---------- helpers ----------
  const localDate = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('en-CA'); };
  const fx = id => db.fixtures[id];
  const notStartedAt = (f, nowMs) => f.status === 'NS' && new Date(f.kickoff).getTime() > nowMs;
  const row = p => {
    const f = fx(p.fixture_id);
    return { id: p.id, tier: p.tier, market: p.market, pick: p.pick, pick_code: p.pick_code, odds: p.odds, odds_source: p.odds_source,
      probability: p.probability, confidence: p.confidence, result: p.result, fixture_id: f.id, kickoff: f.kickoff,
      league_name: f.league_name, league_country: f.league_country, home: f.home, away: f.away, home_logo: null, away_logo: null,
      status: f.status, home_goals: f.home_goals, away_goals: f.away_goals, exp_home: f.exp_home, exp_away: f.exp_away };
  };
  const byKickoff = (a, b) => a.kickoff.localeCompare(b.kickoff);
  const codesOf = accaId => Object.fromEntries(db.codes.filter(c => c.acca_id === accaId).map(c => [c.platform, c.code]));
  const userOf = () => db.users.find(u => u.id === db.session) || null;
  const publicUser = u => ({ id: u.id, phone: u.phone, name: displayPhone(u.phone), isAdmin: !!u.is_admin, platform: u.platform });

  function confidenceStars(prob, tier) {
    const t = TIERS[tier], top = Math.min(0.95, 1 / t.min);
    const x = Math.max(0, Math.min(1, (prob - t.minProb) / (top - t.minProb)));
    return Math.max(1, Math.min(5, Math.round(1 + x * 4)));
  }
  function bestPickForTier(probs, odds, tierKey) {
    const t = TIERS[tierKey], safetyWeight = { low: 1.0, medium: 0.5, high: 0.15 }[tierKey];
    let best = null;
    for (const code of Object.keys(PICKS)) {
      const p = probs[code];
      let o = odds && odds[code], source = 'bookmaker';
      if (!(o > 1)) { o = +(1 / p * 0.93).toFixed(2); source = 'model'; }
      if (o < t.min || o >= t.max || p < t.minProb) continue;
      const edge = p * o - 1;
      if (edge < -0.08) continue;
      const score = edge + safetyWeight * p;
      if (!best || score > best.score) best = { code, prob: p, odds: o, source, score };
    }
    return best;
  }

  // ---------- engine ----------
  async function generateForDate(date, backfill = false) {
    const { fixtures, strengths, odds } = await provider.getDay(date);
    const now = backfill ? new Date(date + 'T00:00:00Z').getTime() : Date.now();
    for (const f of fixtures) {
      const xg = expectedGoals(strengths[f.league_id], f.home, f.away);
      const old = db.fixtures[f.id];
      db.fixtures[f.id] = { ...f, ...(old && old.status !== 'NS' ? { status: old.status, home_goals: old.home_goals, away_goals: old.away_goals } : {}), exp_home: xg.home, exp_away: xg.away };
      if (!notStartedAt(db.fixtures[f.id], now)) continue;
      const probs = blendWithMarket(marketProbabilities(xg.home, xg.away), odds[f.id]);
      for (const tier of Object.keys(TIERS)) {
        const existing = db.preds.find(p => p.fixture_id === f.id && p.tier === tier);
        if (existing) {
          const locked = db.picks.some(x => x.prediction_id === existing.id) ||
            db.legs.some(l => l.prediction_id === existing.id && db.codes.some(c => c.acca_id === l.acca_id));
          if (locked) continue;
        }
        const best = bestPickForTier(probs, odds[f.id], tier);
        if (!best) { if (existing) removePred(existing.id); continue; }
        const data = { fixture_id: f.id, date, tier, market: PICKS[best.code].market, pick: PICKS[best.code].pick, pick_code: best.code,
          odds: best.odds, odds_source: best.source, probability: +best.prob.toFixed(4), confidence: confidenceStars(best.prob, tier) };
        if (existing) Object.assign(existing, data); else db.preds.push({ id: nextId(), result: 'pending', ...data });
      }
    }
    buildAccas(date, now);
    db.runs[date] = true;
  }

  function removePred(id) {
    db.preds = db.preds.filter(p => p.id !== id);
    db.picks = db.picks.filter(p => p.prediction_id !== id);
    const affected = new Set(db.legs.filter(l => l.prediction_id === id).map(l => l.acca_id));
    db.legs = db.legs.filter(l => l.prediction_id !== id);
    affected.forEach(removeAcca);
  }
  function removeAcca(id) {
    db.accas = db.accas.filter(a => a.id !== id);
    db.legs = db.legs.filter(l => l.acca_id !== id);
    db.codes = db.codes.filter(c => c.acca_id !== id);
  }

  function buildAccas(date, nowMs) {
    const preds = db.preds.filter(p => p.date === date && notStartedAt(fx(p.fixture_id), nowMs));
    // Tickets no longer in config (after changing the long bets) are removed unless already booked.
    const keys = ACCAS.map(a => a.key);
    db.accas.filter(a => a.date === date && !keys.includes(a.key) && !db.codes.some(c => c.acca_id === a.id)).forEach(a => removeAcca(a.id));
    for (const spec of ACCAS) {
      const existing = db.accas.find(a => a.date === date && a.key === spec.key);
      if (existing) {
        if (db.codes.some(c => c.acca_id === existing.id)) continue;
        const started = db.legs.filter(l => l.acca_id === existing.id)
          .some(l => { const p = db.preds.find(x => x.id === l.prediction_id); return !p || !notStartedAt(fx(p.fixture_id), nowMs); });
        if (started) continue;
        removeAcca(existing.id);
      }
      const chosen = chooseLegs(preds, spec);
      if (!chosen) continue;
      const id = nextId();
      db.accas.push({ id, date, key: spec.key, grp: spec.group, name: spec.name, total_odds: +chosen.total.toFixed(2), probability: +chosen.prob.toFixed(5), result: 'pending' });
      chosen.legs.forEach(l => db.legs.push({ acca_id: id, prediction_id: l.id }));
    }
  }

  async function settle() {
    const cutoff = Date.now() - 100 * 60000;
    const open = Object.values(db.fixtures).filter(f => !FINISHED.includes(f.status) && new Date(f.kickoff).getTime() <= cutoff);
    if (!open.length) return;
    for (const r of await provider.getResults(open)) {
      Object.assign(db.fixtures[r.id], { status: r.status, home_goals: r.home_goals, away_goals: r.away_goals });
      if (FINISHED.includes(r.status)) {
        db.preds.filter(p => p.fixture_id === r.id && p.result === 'pending')
          .forEach(p => (p.result = settlePick(p.pick_code, r.home_goals, r.away_goals)));
      }
    }
    for (const a of db.accas.filter(a => a.result === 'pending')) {
      const legs = db.legs.filter(l => l.acca_id === a.id).map(l => db.preds.find(p => p.id === l.prediction_id)).filter(Boolean);
      if (legs.some(l => l.result === 'lost')) a.result = 'lost';
      else if (legs.length && legs.every(l => l.result !== 'pending')) a.result = legs.some(l => l.result === 'won') ? 'won' : 'void';
    }
  }

  // Runs every time the app opens: like the server's 6am job and hourly settling.
  let ready;
  function init() {
    if (!ready) ready = (async () => {
      load();
      if (!Object.keys(db.runs).length) for (let i = 7; i >= 1; i--) await generateForDate(localDate(-i), true);
      // Today's picks are made as if at 6am, so games that already kicked off still have picks.
      if (!db.runs[localDate(0)]) await generateForDate(localDate(0), true);
      await generateForDate(localDate(1));
      await settle();
      // Keep the phone's storage small: drop days older than 30.
      const old = localDate(-31);
      const gone = new Set(db.preds.filter(p => p.date < old).map(p => p.id));
      if (gone.size) {
        db.accas.filter(a => a.date < old).forEach(a => removeAcca(a.id));
        db.preds = db.preds.filter(p => !gone.has(p.id)); db.picks = db.picks.filter(p => !gone.has(p.prediction_id));
        for (const [id, f] of Object.entries(db.fixtures)) if (f.date < old) delete db.fixtures[id];
      }
      save();
    })();
    return ready;
  }
  setInterval(() => { if (db) settle().then(save); }, 5 * 60000);

  // ---------- accounts ----------
  async function hash(text) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('oddsday:' + text));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      let h = 2166136261; for (const c of 'oddsday:' + text) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return 'f' + (h >>> 0).toString(16);
    }
  }

  // ---------- routes ----------
  const ok = data => ({ status: 200, data });
  const err = (status, error) => ({ status, data: { error } });

  function predictionRows(filter) { return db.preds.filter(filter).map(row); }
  function ticketsFor(date) {
    const order = ACCAS.map(a => a.key);
    return db.accas.filter(a => a.date === date).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
      .map(a => ({ ...a, codes: codesOf(a.id),
        legs: db.legs.filter(l => l.acca_id === a.id).map(l => db.preds.find(p => p.id === l.prediction_id)).filter(Boolean).map(row).sort(byKickoff) }));
  }
  function addToSlip(userId, predId) {
    const p = db.preds.find(x => x.id === predId);
    if (!p) return 'Pick not found';
    if (!notStartedAt(fx(p.fixture_id), Date.now())) return 'That game has already started';
    if (!db.picks.some(x => x.user_id === userId && x.prediction_id === predId)) db.picks.push({ user_id: userId, prediction_id: predId });
    return null;
  }

  async function route(method, path, body) {
    const url = new URL(path, 'http://local');
    const p = url.pathname, q = url.searchParams;

    if (method === 'POST' && (p === '/api/register' || p === '/api/login')) {
      const phone = normalizePhone(body.phone);
      if (!phone) return err(400, 'Enter a valid phone number, e.g. 024 123 4567');
      let u = db.users.find(x => x.phone === phone);
      if (p === '/api/register') {
        if (u) return err(409, 'That number already has an account. Tap Log in instead.');
        u = { id: nextId(), phone, is_admin: false, platform: 'sportybet' };
        db.users.push(u);
      } else if (!u) return err(404, 'No account for that number yet. Tap Sign up to create one.');
      db.session = u.id; save();
      return ok({ user: publicUser(u) });
    }
    if (method === 'POST' && p === '/api/logout') { db.session = null; save(); return ok({ ok: true }); }

    const user = userOf();
    if (!user) return err(401, 'Please log in');
    const savedSet = () => new Set(db.picks.filter(x => x.user_id === user.id).map(x => x.prediction_id));

    if (method === 'GET' && p === '/api/me') return ok({ user: publicUser(user), demo: true, platforms: PLATFORMS });
    if (method === 'PUT' && p === '/api/me/platform') {
      if (!PLATFORMS.some(x => x.key === body.platform)) return err(400, 'Unknown bookmaker');
      user.platform = body.platform; save(); return ok({ ok: true, platform: user.platform });
    }

    if (method === 'GET' && p === '/api/predictions') {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : localDate(0);
      const saved = savedSet();
      const tiers = { low: [], medium: [], high: [] };
      predictionRows(x => x.date === date).sort((a, b) => byKickoff(a, b) || a.league_name.localeCompare(b.league_name))
        .forEach(r => tiers[r.tier].push({ ...r, saved: saved.has(r.id) }));
      const accas = ticketsFor(date).map(a => ({ ...a, legs: a.legs.map(r => ({ ...r, saved: saved.has(r.id) })) }));
      return ok({ date, demo: true, tiers, accas, tierInfo: TIERS, platforms: PLATFORMS });
    }

    if (method === 'GET' && p === '/api/dashboard') return ok(dashboard(user, savedSet()));

    if (method === 'GET' && p === '/api/stats') {
      const since = localDate(-30), settled = db.preds.filter(x => x.date >= since);
      const tiers = Object.keys(TIERS).map(t => {
        const list = settled.filter(x => x.tier === t), done = list.filter(x => x.result === 'won' || x.result === 'lost');
        return { tier: t, won: done.filter(x => x.result === 'won').length, lost: done.filter(x => x.result === 'lost').length,
          avg_odds: done.length ? +(done.reduce((a, x) => a + x.odds, 0) / done.length).toFixed(2) : null,
          profit: +done.reduce((a, x) => a + (x.result === 'won' ? x.odds - 1 : -1), 0).toFixed(2) };
      });
      const accas = ACCAS.map(s => { const l = db.accas.filter(a => a.key === s.key && a.date >= since);
        return { name: s.name, won: l.filter(a => a.result === 'won').length, lost: l.filter(a => a.result === 'lost').length }; })
        .filter(a => a.won + a.lost);
      return ok({ tiers, accas, recent: dailyRecord(14).reverse() });
    }

    if (method === 'GET' && p === '/api/slip') {
      const ids = savedSet();
      return ok({ picks: predictionRows(x => ids.has(x.id)).sort((a, b) => byKickoff(b, a)) });
    }
    if (method === 'POST' && p === '/api/slip') {
      const e = addToSlip(user.id, Number(body.predictionId)); if (e) return err(400, e); save(); return ok({ ok: true });
    }
    let m;
    if (method === 'POST' && (m = p.match(/^\/api\/slip\/acca\/(\d+)$/))) {
      let added = 0;
      db.legs.filter(l => l.acca_id === Number(m[1])).forEach(l => { if (!addToSlip(user.id, l.prediction_id)) added++; });
      save(); return ok({ ok: true, added });
    }
    if (method === 'DELETE' && (m = p.match(/^\/api\/slip\/(\d+)$/))) {
      db.picks = db.picks.filter(x => !(x.user_id === user.id && x.prediction_id === Number(m[1]))); save(); return ok({ ok: true });
    }

    return err(404, 'Not found');
  }

  function dailyRecord(limit) {
    const days = {};
    for (const p of db.preds) {
      if (p.result !== 'won' && p.result !== 'lost') continue;
      (days[p.date] ||= { date: p.date, won: 0, lost: 0 })[p.result]++;
    }
    return Object.values(days).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  }

  function dashboard(user, saved) {
    const now = Date.now(), today = localDate(0), tomorrow = localDate(1);
    const ns = r => r.status === 'NS' && new Date(r.kickoff).getTime() > now;
    let date = today, picks = predictionRows(x => x.date === today).sort(byKickoff);
    if (!picks.some(ns)) { const t = predictionRows(x => x.date === tomorrow).sort(byKickoff); if (t.length) { date = tomorrow; picks = t; } }
    const open = picks.filter(ns);
    const pickOfDay = open.filter(p => p.tier !== 'high').sort((a, b) => b.probability * Math.sqrt(b.odds) - a.probability * Math.sqrt(a.odds))[0] || null;
    const upcoming = Object.values(db.fixtures).filter(f => f.status === 'NS' && new Date(f.kickoff).getTime() > now && db.preds.some(p => p.fixture_id === f.id)).sort(byKickoff)[0];
    const since = localDate(-30);
    const tiers = Object.keys(TIERS).map(k => {
      const list = picks.filter(p => p.tier === k);
      const hist = db.preds.filter(p => p.tier === k && p.date >= since);
      const won = hist.filter(p => p.result === 'won').length, lost = hist.filter(p => p.result === 'lost').length;
      return { key: k, label: TIERS[k].label, min: TIERS[k].min, max: TIERS[k].max, count: list.length, open: list.filter(ns).length,
        bestOdds: list.length ? Math.max(...list.map(p => p.odds)) : null, won, lost, hitRate: won + lost ? won / (won + lost) : null };
    });
    const tickets = ticketsFor(date).map(a => ({ id: a.id, key: a.key, grp: a.grp, name: a.name, total_odds: a.total_odds, probability: a.probability,
      result: a.result, codes: a.codes, legs: a.legs.length, started: a.legs.filter(l => !ns(l)).length,
      won: a.legs.filter(l => l.result === 'won').length, firstKickoff: a.legs.map(l => l.kickoff).sort()[0] }));
    const games = new Map();
    for (const p of predictionRows(x => x.date === today).sort((a, b) => byKickoff(b, a))) {
      if (ns(p)) continue;
      const g = games.get(p.fixture_id) || { id: p.fixture_id, home: p.home, away: p.away, league: p.league_name, kickoff: p.kickoff,
        status: p.status, home_goals: p.home_goals, away_goals: p.away_goals, won: 0, lost: 0, pending: 0 };
      g[p.result === 'won' ? 'won' : p.result === 'lost' ? 'lost' : 'pending']++;
      games.set(p.fixture_id, g);
    }
    const settledRows = predictionRows(x => x.result === 'won' || x.result === 'lost').sort((a, b) => byKickoff(b, a) || b.id - a.id);
    let streak = 0; for (const r of settledRows.filter(r => r.tier === 'low')) { if (r.result !== 'won') break; streak++; }
    const slip = predictionRows(x => saved.has(x.id)).filter(ns);
    return {
      date, isToday: date === today, now: new Date(now).toISOString(), demo: true, platforms: PLATFORMS,
      totals: { games: new Set(picks.map(p => p.fixture_id)).size, picks: picks.length, open: open.length },
      next: upcoming ? { kickoff: upcoming.kickoff, home: upcoming.home, away: upcoming.away, league_name: upcoming.league_name } : null,
      pickOfDay: pickOfDay && { ...pickOfDay, saved: saved.has(pickOfDay.id) },
      tiers, tickets, live: [...games.values()].slice(0, 12),
      form: settledRows.slice(0, 20).map(r => ({ result: r.result, tier: r.tier, odds: r.odds, home: r.home, away: r.away })),
      days: dailyRecord(14).reverse(), lowStreak: streak,
      slip: { count: slip.length, totalOdds: slip.reduce((x, p) => x * p.odds, 1) },
    };
  }

  return {
    async request(method, path, body) { await init(); return route(method, path, body || {}); },
  };
})();
