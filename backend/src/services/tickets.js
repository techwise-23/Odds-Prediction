// Shared read queries for predictions and tickets (used by the public and admin routes).
const db = require('../db');
const config = require('../config');

function predictionRows(where, params) {
  return db.prepare(`SELECT p.id, p.tier, p.market, p.pick, p.pick_code, p.odds, p.odds_source, p.probability, p.confidence, p.result,
      f.id AS fixture_id, f.kickoff, f.league_name, f.league_country, f.home, f.away, f.home_logo, f.away_logo,
      f.status, f.home_goals, f.away_goals, f.exp_home, f.exp_away
    FROM predictions p JOIN fixtures f ON f.id = p.fixture_id WHERE ${where}`).all(...params);
}

function ticketsFor(date) {
  const order = config.accas.map(a => a.key);
  return db.prepare('SELECT * FROM accas WHERE date = ?').all(date)
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
    .map(a => ({
      ...a,
      codes: Object.fromEntries(db.prepare('SELECT platform, code FROM booking_codes WHERE acca_id = ?').all(a.id).map(r => [r.platform, r.code])),
      legs: predictionRows('p.id IN (SELECT prediction_id FROM acca_legs WHERE acca_id = ?) ORDER BY f.kickoff', [a.id]),
    }));
}

module.exports = { predictionRows, ticketsFor };
