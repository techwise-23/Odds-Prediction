// Starts the API, the daily schedule and the Telegram bot.
// A stray error in a background job (API-Football down, Telegram timeout...) must not take the whole API offline.
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e && e.stack || e));
process.on('uncaughtException', e => console.error('Uncaught exception:', e && e.stack || e));

const config = require('./config');
const db = require('./db');
const settings = require('./settings');
settings.load(); // dashboard settings override the server variables
const engine = require('./engine');
const telegram = require('./telegram');
const notify = require('./notify');
const schedule = require('./schedule');

if (process.env.NODE_ENV === 'production' && !config.persistentStorage) {
  console.error('\n!!! WARNING: the database (' + config.dbFile + ') is NOT on a persistent Volume.\n' +
    '!!! Every deploy will ERASE all users, codes and payments. In Railway: backend service -> Volumes -> add a Volume\n' +
    '!!! (mount path /data), then redeploy. Until then, accounts are lost on each update.\n');
}
// A missing or weak JWT_SECRET used to stop the app from starting (a crash loop on Railway). Now a strong secret is
// created and stored next to the database instead; just warn so it can be set properly.
if (config.jwtSecretSource !== 'env') {
  console.warn(`WARNING: JWT_SECRET is not set (or is too short). Using a ${config.jwtSecretSource} secret${config.jwtSecretSource === 'temporary' ? ' that is lost on restart, so everyone is logged out. Attach a Volume at /data or set JWT_SECRET' : ' stored beside the database. Set JWT_SECRET (24+ characters) to control it'}.`);
}
if (process.env.NODE_ENV === 'production' && !settings.passcodeSet()) {
  console.warn('WARNING: ADMIN_PASSCODE is not set. Anyone who knows an admin phone number can open the admin console.');
}

const app = require('./app');
const posts = require('./posts');

// Expired booking-code posts (daily ones after the cut-off hour, long bets after the last match) are deleted every few minutes.
const sweep = () => { try { const n = posts.cleanup(); if (n) console.log(`Removed ${n} expired post(s)`); } catch (e) { console.error('post cleanup:', e.message); } };
const announce = () => { try { for (const p of posts.takeDue()) require('./notify').postAdded(p).catch(e => console.error('notify:', e.message)); } catch (e) { console.error('announce:', e.message); } };
try { posts.resync(); } catch (e) { console.error('post resync:', e.message); }
sweep(); setInterval(() => { sweep(); announce(); }, 5 * 60000).unref();

// ---------- schedule ----------
try { schedule.start(); } // times come from settings; the admin console can change them live
catch (e) { console.error('Schedule not started (check time zone and cron settings in the admin console):', e.message); }

const server = app.listen(config.port, async () => {
 try {
  console.log(`PawaOdds API on http://localhost:${config.port} (${config.apiKey ? 'LIVE data' : 'DEMO data — add API_FOOTBALL_KEY for real games'})`);
  console.log(`Allowed browser origins: ${config.corsOrigins.join(', ')}`);
  if (config.autoPredictions) {
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
  }
  telegram.startPolling().catch(e => console.error('telegram:', e.message));
  // Missed the 6:00 message (server was down)? Send it now; it only ever goes out once per day.
  if (config.autoPredictions) {
    notify.morning(engine.localDate(0)).catch(e => console.error('notify:', e.message));
    engine.settle().catch(e => console.error('settle:', e.message));
  }
 } catch (e) { console.error('Startup tasks failed (the API is still running):', e.message); }
});

// Railway sends SIGTERM on every redeploy: stop cleanly so the SQLite file is never left mid-write.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  telegram.stopPolling();
  server.close(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref();
});
