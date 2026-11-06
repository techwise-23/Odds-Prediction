// Demo data: realistic sample games so the app works without an API key.
// Shared by the server (src/providers.js) and the standalone phone app (build/build-html.js).
// deps: { leagues, buildStrengths, marketProbabilities, poisson }
function makeDemo({ leagues, buildStrengths, marketProbabilities, poisson }) {
const DEMO_TEAMS = {
  39: ['Arsenal', 'Manchester City', 'Liverpool', 'Chelsea', 'Newcastle', 'Aston Villa', 'Tottenham', 'Manchester United', 'Brighton', 'Crystal Palace', 'Bournemouth', 'Brentford', 'Fulham', 'Nottingham Forest', 'Everton', 'West Ham', 'Wolves', 'Leeds', 'Sunderland', 'Burnley'],
  140: ['Real Madrid', 'Barcelona', 'Atletico Madrid', 'Villarreal', 'Athletic Club', 'Real Betis', 'Real Sociedad', 'Girona', 'Sevilla', 'Celta Vigo', 'Valencia', 'Osasuna', 'Mallorca', 'Getafe', 'Rayo Vallecano', 'Espanyol', 'Alaves', 'Elche', 'Levante', 'Real Oviedo'],
  135: ['Inter', 'Napoli', 'AC Milan', 'Juventus', 'Atalanta', 'Roma', 'Como', 'Lazio', 'Bologna', 'Fiorentina', 'Torino', 'Udinese', 'Genoa', 'Sassuolo', 'Cagliari', 'Lecce', 'Parma', 'Verona', 'Cremonese', 'Pisa'],
  78: ['Bayern Munich', 'Borussia Dortmund', 'Bayer Leverkusen', 'RB Leipzig', 'Stuttgart', 'Eintracht Frankfurt', 'Freiburg', 'Hoffenheim', 'Mainz', 'Werder Bremen', 'Wolfsburg', 'Union Berlin', 'Augsburg', 'Monchengladbach', 'Koln', 'Hamburger SV', 'St. Pauli', 'Heidenheim'],
  61: ['Paris Saint Germain', 'Marseille', 'Monaco', 'Lille', 'Lyon', 'Nice', 'Lens', 'Strasbourg', 'Rennes', 'Toulouse', 'Brest', 'Nantes', 'Auxerre', 'Angers', 'Le Havre', 'Lorient', 'Paris FC', 'Metz'],
  88: ['PSV Eindhoven', 'Ajax', 'Feyenoord', 'AZ Alkmaar', 'FC Twente', 'FC Utrecht', 'NEC Nijmegen', 'Go Ahead Eagles', 'Sparta Rotterdam', 'Heerenveen', 'Groningen', 'Fortuna Sittard', 'PEC Zwolle', 'Heracles', 'NAC Breda', 'Excelsior', 'Telstar', 'Volendam'],
  94: ['Benfica', 'Porto', 'Sporting CP', 'Braga', 'Vitoria Guimaraes', 'Famalicao', 'Gil Vicente', 'Moreirense', 'Casa Pia', 'Estoril', 'Rio Ave', 'Arouca', 'Santa Clara', 'Nacional', 'Estrela', 'Alverca', 'Tondela', 'AVS'],
};

function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function trueRatings(leagueId) {
  const r = rng('ratings' + leagueId);
  const teams = DEMO_TEAMS[leagueId];
  const out = {};
  teams.forEach((t, i) => {
    const s = 1.55 - (1.05 * i) / (teams.length - 1); // best ~1.55, worst ~0.5
    out[t] = { att: s * (0.9 + r() * 0.2), def: (1 / s) * (0.9 + r() * 0.2) };
  });
  return out;
}

function demoXg(leagueId, home, away) {
  const t = trueRatings(leagueId);
  return {
    home: Math.min(4, 1.45 * Math.sqrt(t[home].att * t[away].def) ** 1.6),
    away: Math.min(4, 1.15 * Math.sqrt(t[away].att * t[home].def) ** 1.6),
  };
}

function samplePoisson(lambda, r) {
  let k = 0, p = poisson(0, lambda), c = p; const u = r();
  while (u > c && k < 10) { k++; p = poisson(k, lambda); c += p; }
  return k;
}

  const demo = {
  name: 'demo',
  async getDay(date) {
    const r = rng('day' + date);
    const fixtures = [], strengths = {}, odds = {};
    const day = new Date(date + 'T12:00:00Z').getUTCDay();
    const weekend = day === 0 || day === 6;
    for (const league of leagues.filter(l => DEMO_TEAMS[l.id])) {
      const teams = [...DEMO_TEAMS[league.id]].sort(() => r() - 0.5);
      const count = weekend ? 5 + Math.floor(r() * 4) : 1 + Math.floor(r() * 4); // busy weekends, quieter midweek
      const ratings = trueRatings(league.id);

      // The model sees noisy "standings" built from the true ratings.
      const rows = DEMO_TEAMS[league.id].map(t => {
        const g = (x) => Math.max(0, Math.round(x * 6 * (0.8 + r() * 0.4)));
        return {
          team: t,
          home: { played: 6, for: g(1.45 * ratings[t].att ** 1.3), against: g(1.15 * ratings[t].def ** 1.3) },
          away: { played: 6, for: g(1.15 * ratings[t].att ** 1.3), against: g(1.45 * ratings[t].def ** 1.3) },
        };
      });
      strengths[league.id] = buildStrengths(rows);

      for (let i = 0; i < count; i++) {
        const home = teams[i * 2], away = teams[i * 2 + 1];
        const hour = [12, 14, 15, 16, 17, 19, 20][Math.floor(r() * 7)];
        const id = -Number(date.replace(/-/g, '') + String(league.id).padStart(3, '0') + i);
        fixtures.push({
          id, date, kickoff: `${date}T${String(hour).padStart(2, '0')}:${r() < 0.5 ? '00' : '30'}:00Z`,
          league_id: league.id, league_name: league.name, league_country: league.country,
          home, away, home_logo: null, away_logo: null,
          status: 'NS', home_goals: null, away_goals: null,
        });
        // Bookmaker odds = true probabilities + 6% margin + a little noise.
        const xg = demoXg(league.id, home, away);
        const p = marketProbabilities(xg.home, xg.away);
        const o = {};
        for (const [k, v] of Object.entries(p)) o[k] = Math.max(1.01, +(1 / (v * 1.06 * (0.97 + r() * 0.06))).toFixed(2));
        odds[id] = o;
      }
    }
    return { fixtures, strengths, odds };
  },
  async getResults(fixtures) {
    const now = Date.now();
    return fixtures.map(f => {
      if (new Date(f.kickoff).getTime() + 115 * 60000 > now) return { id: f.id, status: f.status, home_goals: null, away_goals: null };
      const r = rng('result' + f.id);
      const xg = demoXg(f.league_id, f.home, f.away);
      return { id: f.id, status: 'FT', home_goals: samplePoisson(xg.home, r), away_goals: samplePoisson(xg.away, r) };
    });
  },
};

  return demo;
}

if (typeof module !== 'undefined') module.exports = makeDemo;
