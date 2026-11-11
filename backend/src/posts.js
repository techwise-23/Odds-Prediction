// Booking-code posts: the admin books the games on each betting app and posts the codes here.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

// "YYYY-MM-DD" in the app's time zone.
const localDate = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() + offsetDays * 86400000));

// The instant (UTC) when it is `hour`:00 on `dateStr` in the app's time zone.
function zonedInstant(dateStr, hour) {
  const guess = Date.parse(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const get = t => Number(parts.find(p => p.type === t).value);
  const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (shown - guess));
}
const addDays = (dateStr, n) => new Date(Date.parse(dateStr + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// When a post stops being shown.
function expiryFor(kind, date, lastMatchAt) {
  if (kind === 'long') return new Date(new Date(lastMatchAt).getTime() + config.longBetGraceHours * 3600000);
  return zonedInstant(addDays(date, 1), config.postExpireHour);
}

const MAX_IMAGE = 2.5 * 1024 * 1024;
function saveImage(dataUrl) {
  const m = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw Object.assign(new Error('Images must be PNG, JPG, WEBP or GIF'), { status: 400 });
  const data = Buffer.from(m[2], 'base64');
  if (data.length > MAX_IMAGE) throw Object.assign(new Error('Image is too big (max 2.5 MB)'), { status: 400 });
  const id = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO post_images (id, mime, data) VALUES (?,?,?)').run(id, m[1].replace('jpg', 'jpeg'), data);
  return id;
}

const cleanCode = v => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 60);
function cleanLink(v) {
  v = String(v || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) throw 0; return u.toString().slice(0, 500); }
  catch { throw Object.assign(new Error('That link is not valid'), { status: 400 }); }
}

// entries: { sportybet: { code, link, image (data URL, new upload), keepImage (existing id) }, ... }
function normaliseEntries(entries) {
  const out = [];
  for (const p of config.platforms) {
    const e = (entries || {})[p.key];
    if (!e) continue;
    const code = cleanCode(e.code), link = cleanLink(e.link);
    let image = e.image ? saveImage(e.image) : (e.keepImage && /^[0-9a-f]{32}$/.test(e.keepImage) ? e.keepImage : null);
    if (!code && !link && !image) continue;
    out.push({ platform: p.key, code, link, image_id: image });
  }
  return out;
}

// "2026-11-10" -> that day, valid only from today up to 60 days ahead.
function cleanDate(v) {
  const d = String(v || '').trim();
  if (!d) return localDate(0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d + 'T12:00:00Z'))) throw Object.assign(new Error('That date is not valid'), { status: 400 });
  if (d < localDate(0)) throw Object.assign(new Error('That day has already passed'), { status: 400 });
  if (d > localDate(60)) throw Object.assign(new Error('You can schedule at most 60 days ahead'), { status: 400 });
  return d;
}

function create({ kind, title, lastMatchAt, entries, premium, free, by, date: wanted }) {
  if (!['daily', 'long'].includes(kind)) throw Object.assign(new Error('Choose Today or Long bet'), { status: 400 });
  let last = null;
  if (kind === 'long') {
    last = new Date(lastMatchAt);
    if (isNaN(last)) throw Object.assign(new Error('Enter the kickoff time of the LAST match (the post disappears after it is played)'), { status: 400 });
  }
  const rows = normaliseEntries(entries);
  if (!rows.length) throw Object.assign(new Error('Add a code, an image or a link for at least one bookmaker'), { status: 400 });
  const date = kind === 'daily' ? cleanDate(wanted) : localDate(0);
  const startsAt = date > localDate(0) ? zonedInstant(date, 0) : null; // a future day's codes go live at midnight
  const expires = expiryFor(kind, date, last);
  if (expires <= new Date()) throw Object.assign(new Error('That time has already passed'), { status: 400 });
  return db.transaction(() => {
    const { lastInsertRowid: id } = db.prepare('INSERT INTO posts (kind, title, date, last_match_at, expires_at, created_by, premium, free, starts_at, notified) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(kind, String(title || '').trim().slice(0, 80), date, last ? last.toISOString() : null, expires.toISOString(), by || null, premium ? 1 : 0, free ? 1 : 0, startsAt ? startsAt.toISOString() : null, startsAt ? 0 : 1);
    for (const r of rows) db.prepare('INSERT INTO post_entries (post_id, platform, code, link, image_id) VALUES (?,?,?,?,?)').run(id, r.platform, r.code, r.link, r.image_id);
    db.prepare('INSERT INTO results (post_id, kind, title, date) VALUES (?,?,?,?)').run(id, kind, String(title || '').trim().slice(0, 80), date);
    return Number(id);
  })();
}

// Several days at once: [{ date, title, entries }]. All are saved, or none.
function createMany(days, by) {
  if (!Array.isArray(days) || !days.length) throw Object.assign(new Error('Add codes for at least one day'), { status: 400 });
  if (days.length > 31) throw Object.assign(new Error('That is too many days at once (max 31)'), { status: 400 });
  const seen = new Set();
  for (const d of days) { const k = cleanDate(d.date); if (seen.has(k)) throw Object.assign(new Error('The same day is listed twice: ' + k), { status: 400 }); seen.add(k); }
  return db.transaction(() => days.map(d => create({ kind: 'daily', title: d.title, entries: d.entries, date: d.date, by })))();
}

function update(id, { title, lastMatchAt, entries, premium, free }) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!post) throw Object.assign(new Error('Post not found'), { status: 404 });
  const rows = normaliseEntries(entries);
  if (!rows.length) throw Object.assign(new Error('Add a code, an image or a link for at least one bookmaker'), { status: 400 });
  let last = post.last_match_at, expires = post.expires_at;
  if (post.kind === 'long' && lastMatchAt) {
    const d = new Date(lastMatchAt);
    if (isNaN(d)) throw Object.assign(new Error('Enter the kickoff time of the last match'), { status: 400 });
    last = d.toISOString(); expires = expiryFor('long', post.date, d).toISOString();
  }
  db.transaction(() => {
    db.prepare('UPDATE posts SET title = ?, last_match_at = ?, expires_at = ?, premium = ?, free = ? WHERE id = ?').run(String(title ?? post.title).trim().slice(0, 80), last, expires, premium === undefined ? post.premium : (premium ? 1 : 0), free === undefined ? post.free : (free ? 1 : 0), id);
    db.prepare('UPDATE results SET title = ? WHERE post_id = ?').run(String(title ?? post.title).trim().slice(0, 80), id);
    db.prepare('DELETE FROM post_entries WHERE post_id = ?').run(id);
    for (const r of rows) db.prepare('INSERT INTO post_entries (post_id, platform, code, link, image_id) VALUES (?,?,?,?,?)').run(id, r.platform, r.code, r.link, r.image_id);
  })();
  purgeImages();
}

function remove(id) {
  const r = db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  db.prepare("DELETE FROM results WHERE post_id = ? AND status = 'pending'").run(id); // a mistaken post leaves no trace; settled ones stay on record
  purgeImages();
  return r.changes > 0;
}

// Removes expired posts, and any image no entry uses any more.
function purgeImages() { db.prepare('DELETE FROM post_images WHERE id NOT IN (SELECT image_id FROM post_entries WHERE image_id IS NOT NULL)').run(); }
function cleanup() {
  const r = db.prepare('DELETE FROM posts WHERE expires_at <= ?').run(new Date().toISOString());
  purgeImages();
  return r.changes;
}

// Active posts with their per-bookmaker entries, newest first. Without an active pass they come back LOCKED (no codes,
// links or images, only which bookmakers are covered).
function active({ premium = true, scheduled = false } = {}) {
  const now = new Date().toISOString();
  const rows = scheduled ? db.prepare('SELECT * FROM posts WHERE expires_at > ? ORDER BY date DESC, id DESC').all(now)
    : db.prepare('SELECT * FROM posts WHERE expires_at > ? AND (starts_at IS NULL OR starts_at <= ?) ORDER BY id DESC').all(now, now);
  return rows.map(p => {
    const rows = db.prepare('SELECT platform, code, link, image_id FROM post_entries WHERE post_id = ?').all(p.id);
    const locked = !premium && !p.free; // every code needs an active pass, except posts the admin marked free for everyone
    return {
      id: p.id, kind: p.kind, title: p.title, date: p.date, lastMatchAt: p.last_match_at, expiresAt: p.expires_at, createdAt: p.created_at,
      premium: false, free: !!p.free, locked, startsAt: p.starts_at, scheduled: !!(p.starts_at && p.starts_at > now),
      books: rows.map(e => e.platform),
      entries: locked ? {} : Object.fromEntries(rows.map(e => [e.platform, { code: e.code, link: e.link, imageId: e.image_id }])),
    };
  });
}

// Is this image part of a premium post?
const imageIsPremium = id => !db.prepare('SELECT 1 FROM post_entries e JOIN posts p ON p.id = e.post_id WHERE e.image_id = ? AND p.free = 1').get(id); // slip images need a pass unless the post is free

// Re-applies the current expiry rule to daily posts already saved (e.g. after changing POST_EXPIRE_HOUR).
function resync() {
  for (const p of db.prepare("SELECT id, date, expires_at FROM posts WHERE kind = 'daily'").all()) {
    const e = expiryFor('daily', p.date).toISOString();
    if (e !== p.expires_at) db.prepare('UPDATE posts SET expires_at = ? WHERE id = ?').run(e, p.id);
  }
}

// Scheduled posts that have just gone live and have not been announced yet (marks them announced).
function takeDue() {
  const now = new Date().toISOString();
  const ids = db.prepare('SELECT id FROM posts WHERE notified = 0 AND starts_at <= ? AND expires_at > ?').all(now, now).map(r => r.id);
  db.prepare('UPDATE posts SET notified = 1 WHERE notified = 0 AND starts_at <= ?').run(now);
  return active().filter(p => ids.includes(p.id));
}

const image = id => db.prepare('SELECT mime, data FROM post_images WHERE id = ?').get(id) || null;

module.exports = { resync, zonedInstant, addDays, create, createMany, takeDue, update, remove, cleanup, active, image, imageIsPremium, localDate };
