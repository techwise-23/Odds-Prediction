// Telegram bot: sends alerts and lets users link their account by tapping a link (long polling,
// so no public webhook or extra setup is needed).
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const { displayPhone } = require('./phone');

const enabled = () => !!config.telegramToken;
let botName = '';

async function call(method, body = {}, timeoutMs = 15000) {
  const res = await fetch(`${config.telegramApi}/bot${config.telegramToken}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const err = new Error(`Telegram ${method}: ${data.description || res.status}`);
    err.code = res.status; throw err;
  }
  return data.result;
}

const escapeHtml = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Send one message. Returns true if delivered. If the user blocked the bot, the chat is unlinked.
async function send(chatId, html) {
  if (!enabled()) return false;
  try {
    await call('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  } catch (e) {
    if (e.code === 403 || (e.code === 400 && /chat not found/i.test(e.message))) {
      db.prepare('UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = ?').run(String(chatId));
    } else console.warn(e.message);
    return false;
  }
}

function bot() { return botName; }

// ----- linking -----
const LINK_MINUTES = 30;
function newLinkCode(userId) {
  const code = crypto.randomBytes(8).toString('hex');
  db.prepare("UPDATE users SET telegram_link_code = ?, telegram_link_at = datetime('now') WHERE id = ?").run(code, userId);
  return code;
}

async function handleMessage(m) {
  const chatId = String(m.chat.id), text = String(m.text || '').trim();
  if (m.chat.type !== 'private') return;
  const [cmd, arg] = text.split(/\s+/);
  if (cmd === '/start' && arg) {
    const u = db.prepare(`SELECT id, phone FROM users WHERE telegram_link_code = ?
      AND telegram_link_at >= datetime('now', ?)`).get(arg, `-${LINK_MINUTES} minutes`);
    if (!u) return send(chatId, 'That link has expired. Open PawaOdds, tap your profile, then <b>Telegram alerts</b> to get a new one.');
    db.transaction(() => {
      db.prepare('UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = ?').run(chatId);
      db.prepare('UPDATE users SET telegram_chat_id = ?, telegram_link_code = NULL, telegram_link_at = NULL WHERE id = ?').run(chatId, u.id);
    })();
    return send(chatId, `✅ Linked to <b>${escapeHtml(displayPhone(u.phone))}</b>. You will get a message when the morning picks are ready and when a booking code is added for your bookmaker.\n\nSend /stop to turn alerts off.`);
  }
  if (cmd === '/stop') {
    const r = db.prepare('UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = ?').run(chatId);
    return send(chatId, r.changes ? 'Alerts are off. You can turn them on again from the PawaOdds site.' : 'This chat is not linked to an PawaOdds account.');
  }
  return send(chatId, 'Hi! To get PawaOdds alerts, open the site, tap your profile, choose <b>Telegram alerts</b> and press <b>Connect</b>.');
}

// Each call to startPolling begins a new generation; older loops see the change and stop. That makes it
// safe to restart polling when the admin changes the bot token.
let generation = 0;
async function startPolling() {
  const mine = ++generation;
  botName = '';
  if (!enabled()) return;
  try { botName = (await call('getMe')).username || ''; } catch (e) { console.warn('Telegram getMe failed:', e.message); }
  console.log(botName ? `Telegram alerts on (@${botName})` : 'Telegram alerts on');
  let offset = 0, wait = 1000;
  while (generation === mine) {
    try {
      const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35000);
      wait = 1000;
      for (const u of updates) {
        if (generation !== mine) return;
        offset = u.update_id + 1;
        if (u.message && u.message.text) await handleMessage(u.message).catch(e => console.warn('telegram:', e.message));
      }
    } catch (e) {
      if (generation !== mine) return;
      console.warn(e.message);
      await new Promise(r => setTimeout(r, wait)); wait = Math.min(wait * 2, 60000);
    }
  }
}
const stopPolling = () => { generation++; };
// Check a bot token without changing anything.
async function check() { return (await call('getMe')).username || ''; }

module.exports = { enabled, send, bot, newLinkCode, startPolling, stopPolling, check, escapeHtml };
