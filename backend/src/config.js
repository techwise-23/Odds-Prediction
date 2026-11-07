// Central settings. Everything can be overridden with environment variables (see .env.example).
require('./loadEnv');
const { normalizePhone } = require('./phone');

const env = process.env;

// Where the database lives. Users, codes and payments are stored in this one file, so it MUST be on a persistent disk:
// a container's own filesystem is wiped on every deploy, which is why accounts "disappeared" after each GitHub update.
// Order: DB_FILE if set, else the Railway Volume (Railway tells us where it is mounted), else ./data/app.db.
const nodePath = require('path');
const dbPathResolved = env.DB_FILE || (env.RAILWAY_VOLUME_MOUNT_PATH ? nodePath.join(env.RAILWAY_VOLUME_MOUNT_PATH, 'app.db') : nodePath.join(__dirname, '..', 'data', 'app.db'));

// Is that path on a real mounted disk? (A Volume is a separate mount; the container's own disk shares a device with "/".)
function storageIsPersistent(file) {
  try {
    const fs = require('fs');
    const dir = nodePath.dirname(file);
    if (env.RAILWAY_VOLUME_MOUNT_PATH && nodePath.resolve(file).startsWith(nodePath.resolve(env.RAILWAY_VOLUME_MOUNT_PATH))) return true;
    fs.mkdirSync(dir, { recursive: true });
    return fs.statSync(dir).dev !== fs.statSync('/').dev;
  } catch { return true; } // can't tell (e.g. Windows): don't raise a false alarm
}

// Session secret. Use JWT_SECRET when it is set to something strong. Otherwise create a random one once and keep it
// next to the database (on the Railway Volume), so a missing variable never stops the app from starting and logins
// survive redeploys. Set JWT_SECRET yourself if you ever run more than one instance.
function resolveJwtSecret() {
  const given = env.JWT_SECRET || '';
  if (given.length >= 24 && !/^(change-me|replace-with)/.test(given)) return { value: given, source: 'env' };
  const fs = require('fs');
  const path = require('path');
  const dbPath = dbPathResolved;
  const file = path.join(path.dirname(dbPath), '.jwt_secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 24) return { value: saved, source: 'file' };
  } catch { /* not created yet */ }
  const value = require('crypto').randomBytes(32).toString('hex');
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, { mode: 0o600 }); return { value, source: 'generated' }; }
  catch { return { value, source: 'temporary' }; }
}
const jwt = resolveJwtSecret();

// Accept addresses typed the lazy way ("app.up.railway.app", trailing slash, odd case) so CORS still matches the browser's Origin.
const normOrigin = v => {
  v = String(v || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = (/^(localhost|127\.|\[::1\])/.test(v) ? 'http://' : 'https://') + v;
  try { return new URL(v).origin; } catch { return v; }
};

module.exports = {
  port: Number(env.PORT || 3000),
  jwtSecret: jwt.value,
  jwtSecretSource: jwt.source,
  // Browser apps allowed to call this API (comma separated origins): the public site and the admin console.
  corsOrigins: [...new Set((env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174').split(',').concat(env.CORS_ORIGINS ? [env.SITE_URL, env.ADMIN_URL] : []).map(normOrigin).filter(Boolean))],
  // Cookies: 'lax' when the apps share a registrable domain (app.x.com, admin.x.com, api.x.com);
  // 'none' when they live on unrelated domains (e.g. separate *.up.railway.app hosts). 'none' needs HTTPS.
  // In production the sites are usually on separate *.up.railway.app hosts (cross-site), where 'lax' cookies are dropped and login never sticks.
  cookieSameSite: env.COOKIE_SAMESITE || (env.NODE_ENV === 'production' ? 'none' : 'lax'),
  cookieDomain: env.COOKIE_DOMAIN || undefined,
  // Optional extra secret for the admin console login (strongly recommended in production).
  adminPasscode: env.ADMIN_PASSCODE || '',
  dbFile: dbPathResolved,
  // false = the database is on the container's own disk and will be erased by the next deploy.
  persistentStorage: storageIsPersistent(dbPathResolved),

  // API-Football (https://www.api-football.com). Leave empty to run in DEMO mode.
  apiKey: env.API_FOOTBALL_KEY || '',
  apiBase: env.API_FOOTBALL_BASE || 'https://v3.football.api-sports.io',
  // Bookmaker whose odds are shown. 8 = Bet365 on API-Football.
  bookmakerId: Number(env.BOOKMAKER_ID || 8),

  // Time zone used for "today" and for the daily schedule.
  timezone: env.TZ_NAME || 'Africa/Accra',
  // When predictions are generated each day (cron syntax, in the time zone above).
  predictCron: env.PREDICT_CRON || '0 6 * * *',
  // How often finished games are settled (won/lost).
  settleCron: env.SETTLE_CRON || '15 * * * *',

  // Booking-code posts. Daily posts disappear at this hour (local time) on the day after their date.
  postExpireHour: Math.min(23, Math.max(0, Number(env.POST_EXPIRE_HOUR ?? 12))),
  // Long bets disappear this many hours after the LAST match kicks off (a match lasts about 2 hours).
  longBetGraceHours: Number(env.LONG_BET_GRACE_HOURS || 3),
  // The old system-generated predictions and tickets are OFF. Set AUTO_PREDICTIONS=1 to bring them back.
  autoPredictions: env.AUTO_PREDICTIONS === '1',

  // Subscription, paid with Paystack (card or mobile money). Prices are in whole cedis (or the currency below).
  paystack: {
    secret: env.PAYSTACK_SECRET_KEY || '',
    api: (env.PAYSTACK_API_BASE || 'https://api.paystack.co').replace(/\/+$/, ''),
    currency: (env.PAYSTACK_CURRENCY || 'GHS').toUpperCase(),
  },
  // Passes unlock every booking code. Daily: until midnight tonight. Weekly: until the end of Sunday (Monday to Sunday week).
  // Monthly: 30 days from payment. Set a price to 0 to hide that plan.
  premiumPlans: [
    { key: 'daily', name: 'Daily pass', price: Number(env.PREMIUM_PRICE_DAILY ?? 15) },
    { key: 'weekly', name: 'Weekly pass', price: Number(env.PREMIUM_PRICE_WEEKLY ?? 50) },
    { key: 'monthly', name: 'Monthly pass', price: Number(env.PREMIUM_PRICE_MONTHLY ?? 120) },
  ],

  // Telegram alerts (optional). Create a bot with @BotFather and put its token here.
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  telegramApi: env.TELEGRAM_API_BASE || 'https://api.telegram.org', // only changed for tests
  // Public address of the site, used for the "Open PawaOdds" link in messages.
  siteUrl: env.SITE_URL || '',

  // Phone numbers listed here become admins (can re-run predictions from the site).
  adminPhones: (env.ADMIN_PHONES || '').split(',').map(s => normalizePhone(s)).filter(Boolean),

  // Major leagues and cups (API-Football league ids).
  leagues: [
    { id: 39, name: 'Premier League', country: 'England' },
    { id: 140, name: 'La Liga', country: 'Spain' },
    { id: 135, name: 'Serie A', country: 'Italy' },
    { id: 78, name: 'Bundesliga', country: 'Germany' },
    { id: 61, name: 'Ligue 1', country: 'France' },
    { id: 2, name: 'Champions League', country: 'Europe' },
    { id: 3, name: 'Europa League', country: 'Europe' },
    { id: 848, name: 'Conference League', country: 'Europe' },
    { id: 88, name: 'Eredivisie', country: 'Netherlands' },
    { id: 94, name: 'Primeira Liga', country: 'Portugal' },
    { id: 40, name: 'Championship', country: 'England' },
  ],

  // Odds bands for the three daily categories.
  tiers: {
    low: { label: 'Low odds', min: 1.15, max: 1.6, minProb: 0.66 },
    medium: { label: 'Medium odds', min: 1.6, max: 2.5, minProb: 0.45 },
    high: { label: 'High odds', min: 2.5, max: 8.0, minProb: 0.18 },
  },

  // Daily tickets. Each one can get a SportyBet booking code pasted in by an admin.
  // group: 'long' = shown under Long bets; 'low' | 'medium' | 'high' = top ticket on that tab.
  // pool: which picks it may use. minProb: lowest chance allowed for a single leg.
  accas: [
    { key: 'low_top', group: 'low', name: 'Top Low Odds Ticket', target: 3, maxLegs: 5, pool: ['low'], minProb: 0.7 },
    { key: 'medium_top', group: 'medium', name: 'Top Medium Odds Ticket', target: 6, maxLegs: 4, pool: ['medium'], minProb: 0.5 },
    { key: 'high_top', group: 'high', name: 'Top High Odds Ticket', target: 15, maxLegs: 3, pool: ['high'], minProb: 0.25 },
    // Long bets: very big total odds built from MANY games. minLegs = the fewest games allowed.
    // They only appear on days with enough games (weekends and big European nights).
    { key: 'fifty', group: 'long', name: '50 Odds Long Bet', target: 50, minLegs: 8, maxLegs: 12, pool: ['low', 'medium', 'high'], minProb: 0.4 },
    { key: 'hundred', group: 'long', name: '100 Odds Long Bet', target: 100, minLegs: 10, maxLegs: 15, pool: ['low', 'medium', 'high'], minProb: 0.4 },
    { key: 'fivehundred', group: 'long', name: '500 Odds Mega Bet', target: 500, minLegs: 14, maxLegs: 20, pool: ['low', 'medium', 'high'], minProb: 0.4 },
    { key: 'thousand', group: 'long', name: '1000+ Odds Jackpot Bet', target: 1000, minLegs: 18, maxLegs: 26, pool: ['low', 'medium', 'high'], minProb: 0.4 },
  ],

  // Bookmakers users can pick. Admins paste one booking code per bookmaker on each ticket.
  // The url is where the "Open" button sends users; override with e.g. URL_MSPORT in .env.
  platforms: [
    { key: 'sportybet', name: 'SportyBet', url: env.URL_SPORTYBET || env.SPORTYBET_URL || 'https://www.sportybet.com/gh/' },
    { key: 'msport', name: 'MSport', url: env.URL_MSPORT || 'https://www.msport.com/gh/' },
    { key: 'footballcom', name: 'Football.com', url: env.URL_FOOTBALLCOM || 'https://www.football.com/gh/' },
    { key: 'betway', name: 'Betway', url: env.URL_BETWAY || 'https://www.betway.com.gh/' },
  ],
};
