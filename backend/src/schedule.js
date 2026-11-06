// The two recurring jobs. start() can be called again after the admin changes the times or the time zone.
const cron = require('node-cron');
const config = require('./config');
const engine = require('./engine');
const notify = require('./notify');

let tasks = [];

// The daily job: predict, then tell Telegram users the picks are ready.
async function dailyJob() {
  await engine.dailyRun();
  await notify.morning(engine.localDate(0));
}

function stop() { for (const t of tasks) { t.stop(); if (t.destroy) t.destroy(); } tasks = []; }

function start() {
  stop();
  const opts = { timezone: config.timezone };
  if (!config.autoPredictions) return; // booking codes are posted by the admin; nothing is generated
  tasks = [
    cron.schedule(config.predictCron, () => dailyJob().catch(e => console.error(e)), opts),
    cron.schedule(config.settleCron, () => engine.settle().catch(e => console.error(e)), opts),
  ];
}

module.exports = { start, stop, dailyJob };
