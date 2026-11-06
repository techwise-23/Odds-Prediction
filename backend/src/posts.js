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

function create({ kind, title, lastMatchAt, entries, by }) {
  if (!['daily', 'long'].includes(kind)) throw Object.assign(new Error('Choose Today or Long bet'), { status: 400 });
  let last = null;
  if (kind === 'long') {
    last = new Date(lastMatchAt);
    if (isNaN(last)) throw Object.assign(new Error('Enter the kickoff time of the LAST match (the post disappears after it is played)'), { status: 400 });
  }
  const rows = normaliseEntries(entries);
  if (!rows.length) throw Object.assign(new Error('Add a code, an image or a link for at least one bookmaker'), { status: 400 });
  const date = localDate(0);
  const expires = expiryFor(kind, date, last);
  if (expires <= new Date()) throw Object.assign(new Error('That time has already passed'), { status: 400 });
  return db.transaction(() => {
    const { lastInsertRowid: id } = db.prepare('INSERT INTO posts (kind, title, date, last_match_at, expires_at, created_by) VALUES (?,?,?,?,?,?)')
      .run(kind, String(title || '').trim().slice(0, 80), date, last ? last.toISOString() : null, expires.toISOString(), by || null);
    for (const r of rows) db.prepare('INSERT INTO post_entries (post_id, platform, code, link, image_id) VALUES (?,?,?,?,?)').run(id, r.platform, r.code, r.link, r.image_id);
    return Number(id);
  })();
}

function update(id, { title, lastMatchAt, entries }) {
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
    db.prepare('UPDATE posts SET title = ?, last_match_at = ?, expires_at = ? WHERE id = ?').run(String(title ?? post.title).trim().slice(0, 80), last, expires, id);
    db.prepare('DELETE FROM post_entries WHERE post_id = ?').run(id);
    for (const r of rows) db.prepare('INSERT INTO post_entries (post_id, platform, code, link, image_id) VALUES (?,?,?,?,?)').run(id, r.platform, r.code, r.link, r.image_id);
  })();
  purgeImages();
}

function remove(id) {
  const r = db.prepare('DELETE FROM posts WHERE id = ?').run(id);
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

// Active posts with their per-bookmaker entries, newest first.
function active() {
  const now = new Date().toISOString();
  return db.prepare('SELECT * FROM posts WHERE expires_at > ? ORDER BY id DESC').all(now).map(p => ({
    id: p.id, kind: p.kind, title: p.title, date: p.date, lastMatchAt: p.last_match_at, expiresAt: p.expires_at, createdAt: p.created_at,
    entries: Object.fromEntries(db.prepare('SELECT platform, code, link, image_id FROM post_entries WHERE post_id = ?').all(p.id)
      .map(e => [e.platform, { code: e.code, link: e.link, imageId: e.image_id }])),
  }));
}

const image = id => db.prepare('SELECT mime, data FROM post_images WHERE id = ?').get(id) || null;

module.exports = { create, update, remove, cleanup, active, image, localDate };
