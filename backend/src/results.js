// Results center: how the posted booking codes performed. The admin marks each one won, lost or void.
const db = require('./db');

const STATUSES = ['pending', 'won', 'lost', 'void'];

function settle(id, status) {
  if (!STATUSES.includes(status)) throw Object.assign(new Error('Choose won, lost, void or pending'), { status: 400 });
  const r = db.prepare('UPDATE results SET status = ?, settled_at = ? WHERE id = ?').run(status, status === 'pending' ? null : new Date().toISOString(), id);
  if (!r.changes) throw Object.assign(new Error('Result not found'), { status: 404 });
}

const row = r => ({ id: r.id, kind: r.kind, title: r.title, date: r.date, status: r.status });

// For the admin: the latest 60, any status.
const listAll = () => db.prepare('SELECT * FROM results ORDER BY date DESC, id DESC LIMIT 60').all().map(row);

// For users: totals over the last 30 days of posts, the current winning run, and the latest results. No codes in here.
function publicView() {
  const today = require('./posts').localDate(0);
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const c = { won: 0, lost: 0, void: 0, pending: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM results WHERE date >= ? AND date <= ? GROUP BY status').all(since, today)) c[r.status] = r.n;
  const settled = c.won + c.lost;
  let streak = 0;
  for (const r of db.prepare("SELECT status FROM results WHERE status IN ('won','lost') AND date <= ? ORDER BY date DESC, id DESC LIMIT 100").all(today)) { if (r.status !== 'won') break; streak++; }
  const items = db.prepare('SELECT * FROM results WHERE date <= ? ORDER BY date DESC, id DESC LIMIT 40').all(today).map(row);
  return { days: 30, ...c, rate: settled ? Math.round((c.won / settled) * 100) : null, streak, items };
}

module.exports = { settle, listAll, publicView, STATUSES };
