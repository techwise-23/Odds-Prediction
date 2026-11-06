// Demo backend for the admin preview: answers the /api/admin/... calls in the page, using the same sample games as the phone app.
// Nothing here is real data and nothing leaves the page.
(() => {
  const realFetch = window.fetch.bind(window);
  const codes = {};                       // ticketId -> { platform: code }
  const users = [
    { id: 1, phone: '0241234567', is_admin: true, platform: 'sportybet', created_at: '2026-10-02 08:14:00', telegram: true, picks: 12 },
    { id: 2, phone: '0551112233', is_admin: false, platform: 'msport', created_at: '2026-10-19 17:40:00', telegram: true, picks: 7 },
    { id: 3, phone: '0207654321', is_admin: false, platform: 'sportybet', created_at: '2026-10-28 09:02:00', telegram: false, picks: 3 },
    { id: 4, phone: '0509988776', is_admin: false, platform: 'footballcom', created_at: '2026-11-03 21:30:00', telegram: false, picks: 0 },
    { id: 5, phone: '0266543210', is_admin: false, platform: 'betway', created_at: '2026-11-05 06:55:00', telegram: true, picks: 2 },
  ].map(u => ({ ...u, name: Phone.displayPhone(u.phone) }));
  const clone = v => JSON.parse(JSON.stringify(v));
  const INITIAL = { siteUrl: '', timezone: 'Africa/Accra', predictCron: '0 6 * * *', settleCron: '15 * * * *', bookmakerId: 8,
    leagues: clone(CONFIG.leagues), tiers: clone(CONFIG.tiers), accas: clone(CONFIG.accas), platforms: clone(CONFIG.platforms) };
  const S = { ...clone(INITIAL), overridden: new Set(),
    secrets: { apiKey: { set: false, hint: '', source: null }, telegramToken: { set: true, hint: '••••xy9Z', source: 'server' }, passcode: { set: false, source: null } } };
  const GENERAL = ['siteUrl', 'timezone', 'predictCron', 'settleCron', 'bookmakerId'];
  const settingsView = () => ({
    general: Object.fromEntries(GENERAL.map(k => [k, S[k]])), secrets: S.secrets,
    leagues: S.leagues, tiers: S.tiers, accas: S.accas, platforms: S.platforms, overridden: [...S.overridden],
    serverOnly: { corsOrigins: ['https://app.example.com', 'https://admin.example.com'], cookieSameSite: 'lax', port: 3000, dbFile: '/data/app.db', adminPhones: 1, sessionSecretOk: true },
  });
  const adminLog = [];
  const logIt = (action, detail = '') => adminLog.unshift({ admin: '024 123 4567', action, detail, created_at: new Date().toISOString() });
  const deletedTickets = new Set();
  const nowIso = () => new Date().toISOString();
  const ago = m => new Date(Date.now() - m * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const runs = [
    { id: 4, kind: 'settle', date: null, ok: 1, message: '9 picks settled', created_at: ago(40) },
    { id: 3, kind: 'predict', date: null, ok: 1, message: 'Today: 20 games, 59 picks, 6 tickets', created_at: ago(840) },
    { id: 2, kind: 'settle', date: null, ok: 1, message: '14 picks settled', created_at: ago(1480) },
    { id: 1, kind: 'predict', date: null, ok: 1, message: 'Tomorrow: 17 games, 51 picks, 5 tickets', created_at: ago(2280) },
  ];

  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const L = (m, p, b) => LocalAPI.request(m, p, b).then(r => r.data);
  const dateOf = o => { const d = new Date(); d.setDate(d.getDate() + o); return d.toLocaleDateString('en-CA'); };

  async function tickets(date) {
    const { accas } = await L('GET', '/api/predictions?date=' + date);
    return accas.filter(a => !deletedTickets.has(a.id)).map(a => ({ ...a, codes: { ...(a.codes || {}), ...(codes[a.id] || {}) } }));
  }

  async function handle(method, path, body) {
    const platforms = S.platforms;
    if (path === '/api/admin/login') return json({ user: { id: 1, isAdmin: true } });
    if (path === '/api/admin/logout') return json({ ok: true });
    if (path === '/api/admin/me') return json({ user: { id: 1, phone: '0241234567', name: Phone.displayPhone('0241234567'), isAdmin: true, platform: 'sportybet' }, demo: true, platforms, passcodeSet: false });
    if (path === '/api/admin/tickets') {
      return json({ days: await Promise.all([dateOf(0), dateOf(1)].map(async date => ({ date, tickets: await tickets(date) }))), platforms });
    }
    let m;
    if ((m = path.match(/^\/api\/admin\/tickets\/(\d+)\/codes$/)) && method === 'PUT') {
      const id = Number(m[1]); codes[id] = codes[id] || {};
      for (const [k, v] of Object.entries(body.codes || {})) { const c = String(v || '').trim().toUpperCase(); if (c) codes[id][k] = c; else delete codes[id][k]; }
      return json({ ok: true, codes: codes[id] });
    }
    if (path === '/api/admin/users' && method === 'GET') return json({ users });
    if (path === '/api/admin/users' && method === 'POST') {
      if (users.some(u => Phone.normalizePhone(u.phone) === Phone.normalizePhone(body.phone))) return json({ error: 'That number already has an account' }, 409);
      if (!Phone.normalizePhone(body.phone)) return json({ error: 'Enter a valid phone number, e.g. 024 123 4567' }, 400);
      users.unshift({ id: Date.now(), phone: Phone.normalizePhone(body.phone), is_admin: !!body.isAdmin, platform: body.platform, created_at: ago(0), telegram: false, picks: 0, name: Phone.displayPhone(body.phone) });
      logIt('Added a user', Phone.displayPhone(body.phone)); return json({ ok: true });
    }
    if ((m = path.match(/^\/api\/admin\/users\/(\d+)$/)) && method === 'DELETE') {
      const i = users.findIndex(x => x.id === Number(m[1])); if (i < 0) return json({ error: 'User not found' }, 404);
      logIt('Deleted a user', users[i].name); users.splice(i, 1); return json({ ok: true });
    }
    if ((m = path.match(/^\/api\/admin\/tickets\/(\d+)$/)) && method === 'DELETE') { deletedTickets.add(Number(m[1])); logIt('Deleted a ticket'); return json({ ok: true }); }
    if (path === '/api/admin/broadcast') { const n = users.filter(u => u.telegram).length; logIt('Sent a Telegram message', `${n} of ${n} delivered`); return json({ sent: n, total: n }); }
    if (path === '/api/admin/log') return json({ log: adminLog });
    if (path === '/api/admin/settings' && method === 'GET') return json(settingsView());
    if (path === '/api/admin/settings' && method === 'PUT') {
      for (const [k, v] of Object.entries(body)) {
        if (k === 'apiKey' || k === 'telegramToken') {
          if (v === '') { S.overridden.delete(k); S.secrets[k] = k === 'telegramToken' ? { set: true, hint: '••••xy9Z', source: 'server' } : { set: false, hint: '', source: null }; }
          else { S.overridden.add(k); S.secrets[k] = { set: true, hint: '••••' + String(v).slice(-4), source: 'dashboard' }; }
        } else if (k in INITIAL) { S[k] = clone(v); S.overridden.add(k); }
      }
      logIt('Changed settings', Object.keys(body).join(', ')); return json(settingsView());
    }
    if (path === '/api/admin/settings/passcode' && method === 'PUT') {
      S.secrets.passcode = body.passcode ? { set: true, source: 'dashboard' } : { set: false, source: null };
      logIt(body.passcode ? 'Changed the admin passcode' : 'Removed the dashboard passcode'); return json(settingsView());
    }
    if (path === '/api/admin/settings/test') return json({ ok: true, message: 'Preview only: nothing was really tested.' });
    if ((m = path.match(/^\/api\/admin\/settings\/(\w+)$/)) && method === 'DELETE') {
      const k = m[1]; if (k in INITIAL) S[k] = clone(INITIAL[k]); S.overridden.delete(k); S.secrets[k] && k !== 'passcode' && (S.secrets[k] = k === 'telegramToken' ? { set: true, hint: '••••xy9Z', source: 'server' } : { set: false, hint: '', source: null });
      logIt('Reset setting', k); return json(settingsView());
    }
    if ((m = path.match(/^\/api\/admin\/users\/(\d+)\/admin$/)) && method === 'PUT') {
      const u = users.find(x => x.id === Number(m[1])); if (u) u.is_admin = !!body.isAdmin; return json({ ok: true });
    }
    if (path === '/api/admin/runs') return json({ runs });
    if (path === '/api/admin/run') { runs.unshift({ id: runs.length + 1, kind: 'predict', date: dateOf(0), ok: 1, message: 'Preview: nothing was changed', created_at: ago(0) }); return json({ predict: 'ok', settled: { updated: 0 } }); }
    if (path === '/api/admin/settle') return json({ updated: 0 });
    if (path === '/api/admin/overview') {
      const today = dateOf(0), tomorrow = dateOf(1), now = nowIso();
      const days = await Promise.all([today, tomorrow].map(async date => {
        const [tk, pr] = await Promise.all([tickets(date), L('GET', '/api/predictions?date=' + date)]);
        const picks = ['low', 'medium', 'high'].reduce((n, t) => n + pr.tiers[t].length, 0);
        const games = new Set(['low', 'medium', 'high'].flatMap(t => pr.tiers[t].map(x => x.fixture_id))).size;
        return { date, games, picks, tickets: tk.map(a => ({ id: a.id, key: a.key, grp: a.grp, name: a.name, total_odds: a.total_odds, result: a.result,
          legs: a.legs.length, codes: Object.keys(a.codes).length, first_kickoff: a.legs.map(l => l.kickoff).sort()[0] })) };
      }));
      const stats = await L('GET', '/api/stats');
      const tiers = Object.keys(CONFIG.tiers).map(k => { const r = stats.tiers.find(t => t.tier === k) || { won: 0, lost: 0, profit: 0 };
        return { key: k, label: CONFIG.tiers[k].label, won: r.won || 0, lost: r.lost || 0, profit: r.profit || 0, hitRate: r.won + r.lost ? r.won / (r.won + r.lost) : null }; });
      const longs = stats.accas.reduce((a, x) => ({ won: a.won + x.won, lost: a.lost + x.lost }), { won: 0, lost: 0 });
      const attention = [];
      for (const d of days) { const open = d.tickets.filter(t => !t.codes && t.first_kickoff > now);
        if (open.length) attention.push({ level: 'warn', text: `${open.length} ticket${open.length > 1 ? 's' : ''} for ${d.date === today ? 'today' : 'tomorrow'} still need booking codes.`, goto: 'codes' }); }
      attention.push({ level: 'info', text: 'This is a preview with sample games and sample users. Nothing here is real.' });
      const byPlatform = {}; users.forEach(u => { byPlatform[u.platform] = (byPlatform[u.platform] || 0) + 1; });
      const cover = {}; days.forEach(d => d.tickets.forEach(t => { const c = codes[t.id] || {}; Object.keys(c).forEach(p => { cover[p] = (cover[p] || 0) + 1; }); }));
      return json({
        now, today, tomorrow,
        users: { total: users.length, admins: users.filter(u => u.is_admin).length, telegram: users.filter(u => u.telegram).length, day: 1, week: 3 },
        platforms: Object.entries(byPlatform).map(([key, n]) => ({ key, n })), days,
        codeCover: Object.entries(cover).map(([platform, n]) => ({ platform, n })), tiers, longs, attention,
        platformNames: Object.fromEntries(platforms.map(p => [p.key, p.name])),
        runs: { predict: runs.find(r => r.kind === 'predict'), settle: runs.find(r => r.kind === 'settle'), failed24: 0 },
        notifications: { day: { morning: 3, code: 2 }, week: { morning: 18, code: 9 } },
        telegram: { enabled: true, bot: 'oddsday_bot', linked: users.filter(u => u.telegram).length },
        api: { mode: 'demo', calls: 0, since: ago(600) },
        schedule: { predict: '0 6 * * *', settle: '15 * * * *', timezone: 'Africa/Accra' },
      });
    }
    return json({ error: 'Not found' }, 404);
  }

  window.fetch = (url, opts = {}) => {
    const u = String(url), i = u.indexOf('/api/admin/');
    if (i < 0) return realFetch(url, opts);
    return handle((opts.method || 'GET').toUpperCase(), u.slice(i).split('?')[0], opts.body ? JSON.parse(opts.body) : {});
  };
  window.LocalAPI.request('POST', '/api/register', { phone: '0240000000' }).then(r => r.status === 409 && window.LocalAPI.request('POST', '/api/login', { phone: '0240000000' }));
})();
