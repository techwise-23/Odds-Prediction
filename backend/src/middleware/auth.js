// Two separate sessions: one for the public app (bp_session) and one for the admin console (bp_admin).
// Logging in to one never logs you in to the other.
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { displayPhone } = require('../phone');

const USER_COOKIE = 'bp_session';
const ADMIN_COOKIE = 'bp_admin';

const sameSite = config.cookieSameSite;
const cookieOpts = (maxAge) => ({
  httpOnly: true, sameSite,
  secure: process.env.NODE_ENV === 'production' || sameSite === 'none',
  domain: config.cookieDomain, maxAge,
});

// The session is sent twice: as a cookie, and as a token in the response body. Browsers that block cross-site cookies
// (Safari, Brave, Chrome in private mode, which is what the separate *.up.railway.app sites look like) drop the cookie,
// so signing up appeared to work and the very next request said "Please log in". The apps keep the token and send it
// back as an Authorization header instead.
function setUserSession(res, user) {
  const token = jwt.sign({ uid: user.id, aud: 'user' }, config.jwtSecret, { expiresIn: '30d' });
  res.cookie(USER_COOKIE, token, cookieOpts(30 * 86400000));
  return token;
}
function setAdminSession(res, user) {
  // Shorter life than a normal session: the admin console can change codes and user access.
  const token = jwt.sign({ uid: user.id, aud: 'admin' }, config.jwtSecret, { expiresIn: '12h' });
  res.cookie(ADMIN_COOKIE, token, cookieOpts(12 * 3600000));
  return token;
}
function clearSession(res, name) {
  const { maxAge, ...o } = cookieOpts(0);
  res.clearCookie(name, o);
}

const bearer = req => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); return m ? m[1] : ''; };

function userFrom(req, cookie, aud) {
  try {
    const { uid, aud: a } = jwt.verify(bearer(req) || req.cookies[cookie] || '', config.jwtSecret);
    if (a !== aud) return null;
    return db.prepare('SELECT * FROM users WHERE id = ?').get(uid) || null;
  } catch { return null; }
}

function auth(req, res, next) {
  req.user = userFrom(req, USER_COOKIE, 'user');
  req.user ? next() : res.status(401).json({ error: 'Please log in' });
}

// Admin routes: needs the admin cookie AND the user must still be an admin in the database.
function adminAuth(req, res, next) {
  const u = userFrom(req, ADMIN_COOKIE, 'admin');
  if (!u) return res.status(401).json({ error: 'Please log in' });
  if (!u.is_admin) return res.status(403).json({ error: 'Admins only' });
  req.user = u; next();
}

// Basic brute-force protection for login/register.
const attempts = new Map();
function limited(req, res, next) {
  const key = req.ip, now = Date.now();
  const list = (attempts.get(key) || []).filter(t => now - t < 15 * 60000);
  if (list.length >= 20) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  list.push(now); attempts.set(key, list); if (attempts.size > 5000) attempts.clear(); next();
}

function publicUser(u) { return { id: u.id, phone: u.phone, name: displayPhone(u.phone), isAdmin: !!u.is_admin, platform: u.platform || 'sportybet' }; }

module.exports = { USER_COOKIE, ADMIN_COOKIE, setUserSession, setAdminSession, clearSession, auth, adminAuth, limited, publicUser };
