// Data providers. "live" uses API-Football; "demo" generates realistic sample games
// so the whole app can be tried before an API key is added.
const config = require('./config');
const api = require('./apiFootball');
const { buildStrengths, expectedGoals, marketProbabilities, poisson } = require('./model');

const FINISHED = ['FT', 'AET', 'PEN'];
const VOID = ['PST', 'CANC', 'ABD', 'AWD', 'WO'];

// ---------- LIVE (API-Football) ----------
const live = {
  name: 'live',
  async getDay(date) {
    const wanted = new Map(config.leagues.map(l => [l.id, l]));
    const raw = (await api.fixturesByDate(date)).filter(f => wanted.has(f.league.id));
    const fixtures = raw.map(f => ({
      id: f.fixture.id,
      date,
      kickoff: f.fixture.date,
      league_id: f.league.id,
      league_name: wanted.get(f.league.id).name,
      league_country: wanted.get(f.league.id).country,
      season: f.league.season,
      home: f.teams.home.name, away: f.teams.away.name,
      home_logo: f.teams.home.logo, away_logo: f.teams.away.logo,
      status: f.fixture.status.short,
      home_goals: f.goals.home, away_goals: f.goals.away,
    }));

    const strengths = {}, odds = {};
    const leagueSeasons = [...new Map(fixtures.map(f => [f.league_id, f.season])).entries()];
    for (const [league, season] of leagueSeasons) {
      try { strengths[league] = buildStrengths(await api.standings(league, season)); }
      catch (e) { console.warn(`standings ${league}: ${e.message}`); }
      try { Object.assign(odds, await api.oddsByLeagueDate(league, season, date)); }
      catch (e) { console.warn(`odds ${league}: ${e.message}`); }
    }
    return { fixtures, strengths, odds };
  },
  async getResults(fixtures) {
    const rows = await api.fixturesByIds(fixtures.map(f => f.id));
    return rows.map(f => ({
      id: f.fixture.id, status: f.fixture.status.short,
      home_goals: f.goals.home, away_goals: f.goals.away,
    }));
  },
};

// ---------- DEMO ----------
const demo = require('./demo')({ leagues: config.leagues, buildStrengths, marketProbabilities, poisson });

function current() { return config.apiKey ? live : demo; }

module.exports = { current, FINISHED, VOID, expectedGoals };
