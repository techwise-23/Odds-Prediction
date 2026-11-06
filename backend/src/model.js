// Prediction model: team strengths -> expected goals -> Poisson score matrix -> market probabilities.

const MAX_GOALS = 10;

function poisson(k, lambda) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

/**
 * Build team strength tables from a league's standings rows.
 * rows: [{ team, home:{played,for,against}, away:{played,for,against} }]
 */
function buildStrengths(rows) {
  let hg = 0, ag = 0, games = 0;
  for (const r of rows) {
    hg += r.home.for; ag += r.away.for; games += r.home.played;
  }
  // League averages with sensible fallbacks early in the season.
  const avgHome = games >= 10 ? hg / games : 1.5;
  const avgAway = games >= 10 ? ag / games : 1.2;

  const teams = {};
  for (const r of rows) {
    const shrink = (value, played) => {
      const w = played / (played + 4); // pull small samples towards average
      return 1 + (value - 1) * w;
    };
    const hp = Math.max(r.home.played, 0), ap = Math.max(r.away.played, 0);
    teams[r.team] = {
      homeAttack: shrink(hp ? r.home.for / hp / avgHome : 1, hp),
      homeDefence: shrink(hp ? r.home.against / hp / avgAway : 1, hp),
      awayAttack: shrink(ap ? r.away.for / ap / avgAway : 1, ap),
      awayDefence: shrink(ap ? r.away.against / ap / avgHome : 1, ap),
    };
  }
  return { avgHome, avgAway, teams };
}

function expectedGoals(strengths, home, away) {
  const s = strengths || { avgHome: 1.5, avgAway: 1.2, teams: {} };
  const h = s.teams[home] || { homeAttack: 1, homeDefence: 1 };
  const a = s.teams[away] || { awayAttack: 1, awayDefence: 1 };
  const clamp = v => Math.min(Math.max(v, 0.2), 4.5);
  return {
    home: clamp(h.homeAttack * a.awayDefence * s.avgHome),
    away: clamp(a.awayAttack * h.homeDefence * s.avgAway),
  };
}

// Probabilities for every market the app predicts.
function marketProbabilities(xgHome, xgAway) {
  const ph = [], pa = [];
  for (let i = 0; i <= MAX_GOALS; i++) { ph.push(poisson(i, xgHome)); pa.push(poisson(i, xgAway)); }

  let H = 0, D = 0, A = 0, btts = 0;
  const totals = new Array(2 * MAX_GOALS + 1).fill(0);
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = ph[i] * pa[j];
      if (i > j) H += p; else if (i === j) D += p; else A += p;
      if (i > 0 && j > 0) btts += p;
      totals[i + j] += p;
    }
  }
  const sum = H + D + A; // normalise truncation error
  H /= sum; D /= sum; A /= sum; btts /= sum;
  const under = line => totals.slice(0, Math.floor(line) + 1).reduce((x, y) => x + y, 0) / sum;

  return {
    H, D, A,
    '1X': H + D, X2: D + A, '12': H + A,
    O15: 1 - under(1.5), U15: under(1.5),
    O25: 1 - under(2.5), U25: under(2.5),
    O35: 1 - under(3.5), U35: under(3.5),
    BTTS_Y: btts, BTTS_N: 1 - btts,
  };
}

// Human labels for each pick code.
const PICKS = {
  H: { market: 'Match Result', pick: 'Home Win' },
  D: { market: 'Match Result', pick: 'Draw' },
  A: { market: 'Match Result', pick: 'Away Win' },
  '1X': { market: 'Double Chance', pick: 'Home or Draw (1X)' },
  X2: { market: 'Double Chance', pick: 'Draw or Away (X2)' },
  '12': { market: 'Double Chance', pick: 'Home or Away (12)' },
  O15: { market: 'Total Goals', pick: 'Over 1.5' },
  U15: { market: 'Total Goals', pick: 'Under 1.5' },
  O25: { market: 'Total Goals', pick: 'Over 2.5' },
  U25: { market: 'Total Goals', pick: 'Under 2.5' },
  O35: { market: 'Total Goals', pick: 'Over 3.5' },
  U35: { market: 'Total Goals', pick: 'Under 3.5' },
  BTTS_Y: { market: 'Both Teams Score', pick: 'Yes (GG)' },
  BTTS_N: { market: 'Both Teams Score', pick: 'No (NG)' },
};

// Groups of codes that come from the same bookmaker market (for removing the margin).
const MARKET_GROUPS = [['H', 'D', 'A'], ['O15', 'U15'], ['O25', 'U25'], ['O35', 'U35'], ['BTTS_Y', 'BTTS_N']];

/**
 * Blend model probabilities with bookmaker-implied probabilities (margin removed).
 * The market is usually well informed, so we trust it as much as the model.
 */
function blendWithMarket(modelP, odds, marketWeight = 0.5) {
  const out = { ...modelP };
  if (!odds) return out;
  for (const group of MARKET_GROUPS) {
    if (!group.every(c => odds[c] > 1)) continue;
    const implied = group.map(c => 1 / odds[c]);
    const total = implied.reduce((a, b) => a + b, 0);
    group.forEach((c, i) => {
      out[c] = (1 - marketWeight) * modelP[c] + marketWeight * (implied[i] / total);
    });
  }
  // Keep double chance consistent with blended 1X2.
  out['1X'] = out.H + out.D; out.X2 = out.D + out.A; out['12'] = out.H + out.A;
  return out;
}

/**
 * Did the pick win? Returns 'won' | 'lost'.
 */
function settlePick(code, hg, ag) {
  const t = hg + ag;
  switch (code) {
    case 'H': return hg > ag ? 'won' : 'lost';
    case 'D': return hg === ag ? 'won' : 'lost';
    case 'A': return ag > hg ? 'won' : 'lost';
    case '1X': return hg >= ag ? 'won' : 'lost';
    case 'X2': return ag >= hg ? 'won' : 'lost';
    case '12': return hg !== ag ? 'won' : 'lost';
    case 'O15': return t > 1.5 ? 'won' : 'lost';
    case 'U15': return t < 1.5 ? 'won' : 'lost';
    case 'O25': return t > 2.5 ? 'won' : 'lost';
    case 'U25': return t < 2.5 ? 'won' : 'lost';
    case 'O35': return t > 3.5 ? 'won' : 'lost';
    case 'U35': return t < 3.5 ? 'won' : 'lost';
    case 'BTTS_Y': return hg > 0 && ag > 0 ? 'won' : 'lost';
    case 'BTTS_N': return hg === 0 || ag === 0 ? 'won' : 'lost';
    default: return 'void';
  }
}

/**
 * Pick the games (legs) for one ticket. Used by the server and the phone app.
 * preds: [{ fixture_id, tier, odds, probability, ... }]; spec: an entry of config.accas.
 * Returns { legs, total, prob } or null when there aren't enough suitable games.
 *
 * Top tickets (low/medium/high) stop as soon as they reach their target odds.
 * Long bets (spec.minLegs) are different: they need MANY games and very big total odds,
 * so they use one pick per game, add the safest ones first, and keep going until both
 * the minimum number of games and the target odds are reached.
 */
function chooseLegs(preds, spec) {
  const eligible = preds.filter(p => spec.pool.includes(p.tier) && p.probability >= spec.minProb)
    .map(p => ({ ...p, eff: Math.log(p.odds) / -Math.log(p.probability) }));

  const finish = legs => ({ legs, total: legs.reduce((x, l) => x * l.odds, 1), prob: legs.reduce((x, l) => x * l.probability, 1) });

  if (!spec.minLegs) {
    const ranked = eligible.sort((a, b) => spec.group === 'low' ? b.probability - a.probability : b.eff - a.eff);
    const legs = [], used = new Set();
    let total = 1;
    for (const p of ranked) {
      if (used.has(p.fixture_id)) continue;
      // Don't overshoot the target by much with one big leg; look for a smaller one instead.
      if (legs.length && total * p.odds > spec.target * 1.5) continue;
      legs.push(p); used.add(p.fixture_id); total *= p.odds;
      if (total >= spec.target || legs.length >= spec.maxLegs) break;
    }
    return legs.length < 2 || total < spec.target * 0.6 ? null : finish(legs);
  }

  // Long bet: one pick per game. For every possible number of games n we aim each leg at the odds
  // d = target^(1/n) (so n legs multiply up to about the target), take the n picks closest to that,
  // and keep the valid ticket (total between the target and double it) with the best chance of winning.
  let best = null;
  for (let n = spec.minLegs; n <= spec.maxLegs; n++) {
    for (const aim of [1.0, 1.15, 1.3, 1.5, 1.75]) {
      const lnD = Math.log(spec.target * aim) / n;
      const perGame = new Map();
      for (const p of eligible) {
        const score = Math.abs(Math.log(p.odds) - lnD) + 0.3 * (1 - p.probability);
        const c = perGame.get(p.fixture_id);
        if (!c || score < c.score) perGame.set(p.fixture_id, { ...p, score });
      }
      if (perGame.size < n) break; // not enough games for more legs
      const legs = [...perGame.values()].sort((a, b) => a.score - b.score).slice(0, n);
      const r = finish(legs);
      if (r.total >= spec.target && r.total <= spec.target * 2 && (!best || r.prob > best.prob)) best = r;
    }
  }
  if (best) best.legs.sort((a, b) => b.probability - a.probability);
  return best;
}

module.exports = { chooseLegs, buildStrengths, expectedGoals, marketProbabilities, blendWithMarket, settlePick, PICKS, poisson };
