// Minimal API-Football v3 client. Docs: https://www.api-football.com/documentation-v3
// Settings are read on every call so changes made in the admin console apply straight away.
const config = require('./config');

let callsToday = 0;

async function get(endpoint, params = {}) {
  const url = new URL(config.apiBase + endpoint);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'x-apisports-key': config.apiKey } });
  callsToday++;
  if (!res.ok) throw new Error(`API-Football ${endpoint} HTTP ${res.status}`);
  const body = await res.json();
  const errs = body.errors && (Array.isArray(body.errors) ? body.errors : Object.values(body.errors));
  if (errs && errs.length) throw new Error(`API-Football ${endpoint}: ${errs.join('; ')}`);
  return body;
}

// All fixtures on a date (one call), each with league, teams, kickoff and status.
async function fixturesByDate(date) {
  const body = await get('/fixtures', { date, timezone: config.timezone });
  return body.response;
}

async function fixturesByIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 20) {
    const body = await get('/fixtures', { ids: ids.slice(i, i + 20).join('-'), timezone: config.timezone });
    out.push(...body.response);
  }
  return out;
}

// Standings rows normalised for the model. Cups with groups return several tables; we merge them.
async function standings(league, season) {
  const body = await get('/standings', { league, season });
  const rows = [];
  for (const item of body.response) {
    for (const table of item.league.standings) {
      for (const r of table) {
        rows.push({
          team: r.team.name,
          home: { played: r.home.played, for: r.home.goals.for, against: r.home.goals.against },
          away: { played: r.away.played, for: r.away.goals.for, against: r.away.goals.against },
        });
      }
    }
  }
  return rows;
}

// Bookmaker odds for a league on a date, keyed by fixture id -> { H, D, A, '1X', ... }.
async function oddsByLeagueDate(league, season, date) {
  const result = {};
  let page = 1, total = 1;
  do {
    const body = await get('/odds', { league, season, date, bookmaker: config.bookmakerId, page, timezone: config.timezone });
    total = body.paging ? body.paging.total : 1;
    for (const item of body.response) {
      const bm = item.bookmakers && item.bookmakers[0];
      if (!bm) continue;
      const o = {};
      for (const bet of bm.bets) {
        for (const v of bet.values) {
          const odd = parseFloat(v.odd);
          const val = String(v.value);
          if (bet.id === 1) {
            if (val === 'Home') o.H = odd; if (val === 'Draw') o.D = odd; if (val === 'Away') o.A = odd;
          } else if (bet.id === 12) {
            if (val === 'Home/Draw') o['1X'] = odd;
            if (val === 'Draw/Away') o.X2 = odd;
            if (val === 'Home/Away') o['12'] = odd;
          } else if (bet.id === 5) {
            const m = val.match(/^(Over|Under) (1\.5|2\.5|3\.5)$/);
            if (m) o[(m[1] === 'Over' ? 'O' : 'U') + m[2].replace('.', '')] = odd;
          } else if (bet.id === 8) {
            if (val === 'Yes') o.BTTS_Y = odd; if (val === 'No') o.BTTS_N = odd;
          }
        }
      }
      result[item.fixture.id] = o;
    }
    page++;
  } while (page <= total && page <= 5);
  return result;
}

// Account check used by the admin console's "Test" button.
async function status() { const b = await get('/status'); return b.response || {}; }

module.exports = { status, fixturesByDate, fixturesByIds, standings, oddsByLeagueDate, callCount: () => callsToday };
