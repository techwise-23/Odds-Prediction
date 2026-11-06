// Starts the API, the daily schedule and the Telegram bot.
const config = require('./config');
const db = require('./db');
const settings = require('./settings');
settings.load(); // dashboard settings override the server variables
const engine = require('./engine');
const telegram = require('./telegram');
const notify = require('./notify');
const schedule = require('./schedule');

// Refuse to run in production with a guessable session secret.
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || /^(change-me|replace-with)/.test(config.jwtSecret) || config.jwtSecret.length < 24)) {
  console.error('JWT_SECRET must be set to a long random string (24+ characters) in production.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && !settings.passcodeSet()) {
  console.warn('WARNING: ADMIN_PASSCODE is not set. Anyone who knows an admin phone number can open the admin console.');
}

const app = require('./app');

// ---------- schedule ----------
schedule.start(); // times come from settings; the admin console can change them live

const server = app.listen(config.port, async () => {
  console.log(`OddsDay API on http://localhost:${config.port} (${config.apiKey ? 'LIVE data' : 'DEMO data — add API_FOOTBALL_KEY for real games'})`);
  console.log(`Allowed browser origins: ${config.corsOrigins.join(', ')}`);
  // First start of the day: make sure today's picks exist.
  const today = engine.localDate(0);
  // Demo mode: create a week of settled history so the track record page has something to show.
  if (!config.apiKey && !db.prepare('SELECT 1 FROM predictions LIMIT 1').get()) {
    for (let i = 7; i >= 0; i--) await engine.generateForDate(engine.localDate(-i), { backfill: true });
  }
  const has = d => db.prepare('SELECT 1 FROM runs WHERE kind = ? AND date = ? AND ok = 1 LIMIT 1').get('predict', d);
  if (!has(today) || !has(engine.localDate(1))) {
    console.log("Today's or tomorrow's predictions are missing — generating now...");
    console.log(await engine.dailyRun().catch(e => e.message));
  }
  telegram.startPolling();
  // Missed the 6:00 message (server was down)? Send it now; it only ever goes out once per day.
  notify.morning(today).catch(e => console.error('notify:', e.message));
  engine.settle().catch(e => console.error('settle:', e.message));
});

// Railway sends SIGTERM on every redeploy: stop cleanly so the SQLite file is never left mid-write.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  telegram.stopPolling();
  server.close(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref();
});
