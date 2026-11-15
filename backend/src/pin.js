// Player PINs: 4 to 6 digits, stored as a salted scrypt hash. Wrong guesses lock the account for a while, so a PIN cannot be brute-forced.
const crypto = require('crypto');
const db = require('./db');

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const valid = pin => /^\d{4,6}$/.test(String(pin || ''));
const WEAK = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '123456', '654321', '000000', '111111', '121212', '123123']);

function hash(pin) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
function matches(stored, pin) {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  const a = crypto.scryptSync(String(pin || ''), Buffer.from(salt, 'hex'), 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function check(pin) { // for choosing a PIN
  if (!valid(pin)) throw fail('Your PIN must be 4 to 6 digits');
  if (WEAK.has(String(pin))) throw fail('That PIN is too easy to guess. Pick another one.');
}
function set(userId, pin) {
  check(pin);
  db.prepare('UPDATE users SET pin_hash = ?, pin_fails = 0, pin_locked_until = NULL WHERE id = ?').run(hash(pin), userId);
}
function reset(userId) { db.prepare('UPDATE users SET pin_hash = NULL, pin_fails = 0, pin_locked_until = NULL WHERE id = ?').run(userId); }

// Checks a PIN for an account that has one. 5 wrong tries lock it for 15 minutes, 10 for 1 hour, 15 or more for 24 hours.
function verify(userId, pin) {
  const u = db.prepare('SELECT pin_hash, pin_fails, pin_locked_until FROM users WHERE id = ?').get(userId);
  if (!u || !u.pin_hash) throw fail('Set a PIN first', 403);
  if (u.pin_locked_until && new Date(u.pin_locked_until) > new Date()) {
    const mins = Math.ceil((new Date(u.pin_locked_until) - Date.now()) / 60000);
    throw fail(`Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 429);
  }
  if (valid(pin) && matches(u.pin_hash, pin)) {
    if (u.pin_fails) db.prepare('UPDATE users SET pin_fails = 0, pin_locked_until = NULL WHERE id = ?').run(userId);
    return true;
  }
  const fails = u.pin_fails + 1, ms = fails >= 15 ? 864e5 : fails >= 10 ? 36e5 : fails >= 5 && fails % 5 === 0 ? 9e5 : 0;
  db.prepare('UPDATE users SET pin_fails = ?, pin_locked_until = ? WHERE id = ?').run(fails, ms ? new Date(Date.now() + ms).toISOString() : null, userId);
  throw fail(ms ? 'Too many wrong PINs. This account is locked for a while.' : 'Wrong PIN', 403);
}
const has = userId => !!(db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(userId) || {}).pin_hash;

module.exports = { valid, check, set, reset, verify, has };
