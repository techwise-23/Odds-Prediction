// Alerts sent to users who linked Telegram: morning picks and new booking codes.
const db = require('./db');
const config = require('./config');
const telegram = require('./telegram');
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
  if (!post || !telegram.enabled()) return { sent: 0 };
  const what = (post.kind === 'long' ? 'long bet booking code' : "today's booking code");
  let sent = 0;
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

module.exports = { morning, codeAdded, postAdded };
