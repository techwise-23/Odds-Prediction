// Alerts sent to users who linked Telegram: morning picks and new booking codes.
const db = require('./db');
const config = require('./config');
const telegram = require('./telegram');
const push = require('./push');
const { escapeHtml: h } = telegram;

const platformOf = key => config.platforms.find(p => p.key === key) || config.platforms[0];
const footer = () => (config.siteUrl ? `\n\n<a href="${h(config.siteUrl)}">Open PawaOdds</a>` : '');
const money = n => Number(n).toFixed(2);

// Send once per user per (kind, ref). The log row is removed again if sending failed, so a later run retries.
async function sendOnce(user, kind, ref, html) {
  const r = db.prepare('INSERT OR IGNORE INTO notification_log (user_id, kind, ref) VALUES (?,?,?)').run(user.id, kind, ref);
  if (!r.changes) return false;
  const ok = await telegram.send(user.telegram_chat_id, html);
  if (!ok) db.prepare('DELETE FROM notification_log WHERE user_id = ? AND kind = ? AND ref = ?').run(user.id, kind, ref);
  return ok;
}

const linkedUsers = flag => db.prepare(`SELECT * FROM users WHERE telegram_chat_id IS NOT NULL AND blocked = 0 AND ${flag} = 1`).all();

function tickets(date) {
  const order = config.accas.map(a => a.key), now = new Date().toISOString();
  return db.prepare('SELECT * FROM accas WHERE date = ?').all(date)
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
    .map(a => ({
      ...a,
      codes: Object.fromEntries(db.prepare('SELECT platform, code FROM booking_codes WHERE acca_id = ?').all(a.id).map(r => [r.platform, r.code])),
      legs: db.prepare(`SELECT f.kickoff, f.status FROM acca_legs l JOIN predictions p ON p.id = l.prediction_id
        JOIN fixtures f ON f.id = p.fixture_id WHERE l.acca_id = ?`).all(a.id),
    }))
    .filter(a => a.legs.length && a.legs.some(l => l.status === 'NS' && l.kickoff > now)); // still bookable
}

// "Picks are ready" message, sent once per day to everyone who has it switched on.
async function morning(date) {
  if (!telegram.enabled()) return { sent: 0 };
  const list = tickets(date);
  const stats = db.prepare('SELECT COUNT(*) picks, COUNT(DISTINCT fixture_id) games FROM predictions WHERE date = ?').get(date);
  if (!stats.picks) return { sent: 0 };
  const dayName = new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  let sent = 0;
  for (const u of linkedUsers('notify_picks')) {
    const pf = platformOf(u.platform);
    const lines = list.map(t => {
      const code = t.codes[pf.key];
      return `🎟 <b>${h(t.name)}</b> · ${money(t.total_odds)} odds · ${t.legs.length} games` +
        (code ? `\n     ${h(pf.name)} code: <code>${h(code)}</code>` : '');
    });
    const text = `☀️ <b>Today's picks are ready</b>\n${h(dayName)}\n\n${stats.games} games · ${stats.picks} picks` +
      (lines.length ? `\n\n${lines.join('\n')}\n\n<i>Codes for ${h(pf.name)} are sent here as soon as they are added.</i>` : '') + footer();
    if (await sendOnce(u, 'morning', date, text)) sent++;
  }
  return { sent };
}

// A booking code was added or changed: tell users whose chosen bookmaker it is.
async function codeAdded(accaId, platformKey, code) {
  if (!telegram.enabled()) return { sent: 0 };
  const t = tickets(db.prepare('SELECT date FROM accas WHERE id = ?').get(accaId)?.date).find(x => x.id === accaId);
  if (!t) return { sent: 0 }; // ticket not found or all its games have started
  const pf = platformOf(platformKey);
  let sent = 0;
  for (const u of linkedUsers('notify_codes').filter(x => x.platform === platformKey)) {
    const text = `🔑 <b>${h(pf.name)} code ready</b>\n${h(t.name)} · ${money(t.total_odds)} odds · ${t.legs.length} games\n\n` +
      `Code: <code>${h(code)}</code>\n\nOn ${h(pf.name)}, open the betslip, enter the booking code and load it. Their odds may differ slightly from ours.` +
      (pf.url ? `\n<a href="${h(pf.url)}">Open ${h(pf.name)}</a>` : '');
    if (await sendOnce(u, 'code', `${accaId}:${platformKey}:${code}`, text)) sent++;
  }
  return { sent };
}

// The admin posted booking codes: tell users on each bookmaker that has a code, link or image for them.
async function postAdded(post) {
  if (!post) return { sent: 0 };
  const what = (post.kind === 'long' ? 'long bet booking code' : "today's booking code");
  let sent = 0;
  // Phone alerts: everyone who turned them on and has an active pass, for a bookmaker this post covers.
  const subs = db.prepare(`SELECT DISTINCT u.* FROM users u JOIN push_subs s ON s.user_id = u.id WHERE u.blocked = 0 AND u.premium_until > ?`).all(new Date().toISOString());
  for (const u of subs) {
    if (!post.entries[u.platform]) continue;
    const r = db.prepare('INSERT OR IGNORE INTO notification_log (user_id, kind, ref) VALUES (?,?,?)').run(u.id, 'push-post', String(post.id));
    if (!r.changes) continue;
    if (await push.sendToUser(u.id, { title: `New ${what}`, body: post.title || 'Tap to open it on PawaOdds', url: '/' })) sent++;
    else db.prepare('DELETE FROM notification_log WHERE user_id = ? AND kind = ? AND ref = ?').run(u.id, 'push-post', String(post.id));
  }
  if (!telegram.enabled()) return { sent };
  for (const u of linkedUsers('notify_codes')) {
    const e = post.entries[u.platform];
    if (!e) continue;
    if (!(u.premium_until && new Date(u.premium_until) > new Date())) continue; // codes only go to subscribers
    const pf = platformOf(u.platform);
    const lines = [`🔑 <b>${h(what[0].toUpperCase() + what.slice(1))}</b>${post.title ? ' · ' + h(post.title) : ''}`, `${h(pf.name)}:`];
    if (e.code) lines.push(`<code>${h(e.code)}</code>`);
    if (e.link) lines.push(`<a href="${h(e.link)}">Open the slip</a>`);
    if (e.imageId) lines.push('<i>A slip screenshot is waiting in the app.</i>');
    if (pf.url) lines.push(`\n<a href="${h(pf.url)}">Open ${h(pf.name)}</a>`);
    if (await sendOnce(u, 'post', `${post.id}:${u.platform}`, lines.join('\n') + footer())) sent++;
  }
  return { sent };
}

// Tells people their pass is about to end (once per pass), by phone alert and Telegram.
async function renewals() {
  const premium = require('./premium');
  const now = Date.now(), soon = new Date(now + 24 * 3600000).toISOString();
  let sent = 0;
  const due = db.prepare('SELECT * FROM users WHERE blocked = 0 AND premium_until > ? AND premium_until <= ? AND (renew_notified IS NULL OR renew_notified != premium_until)')
    .all(new Date(now).toISOString(), soon);
  for (const u of due) {
    if (!premium.status(u).endsSoon) continue; // a daily pass is only warned about in its last hours
    const when = new Date(u.premium_until).toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: config.timezone });
    const text = `Your PawaOdds pass ends ${when}. Renew to keep every booking code.`;
    let ok = await push.sendToUser(u.id, { title: 'Your pass is ending', body: text, url: '/' });
    if (u.telegram_chat_id && u.notify_codes && telegram.enabled() && await telegram.send(u.telegram_chat_id, `⏰ ${h(text)}${footer()}`)) ok = 1;
    db.prepare('UPDATE users SET renew_notified = ? WHERE id = ?').run(u.premium_until, u.id);
    if (ok) sent++;
  }
  return { sent };
}

module.exports = { morning, codeAdded, postAdded, renewals };
