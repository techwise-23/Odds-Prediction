// Run the daily job by hand:  npm run predict   (or: npm run settle)
const settings = require('./settings');
settings.load();
const engine = require('./engine');

(async () => {
  const cmd = process.argv[2] || 'predict';
  // Locked out of the admin console? This removes the passcode set there:  node src/cli.js reset-passcode
  if (cmd === 'reset-passcode') { settings.setPasscode(''); return console.log('Dashboard passcode removed. ADMIN_PASSCODE from the server (if any) applies again.'); }
  if (cmd === 'predict') console.log(await engine.dailyRun());
  if (cmd === 'settle' || cmd === 'predict') console.log(await engine.settle());
})().catch(e => { console.error(e); process.exit(1); });
