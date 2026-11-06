// OddsDay admin console — its own site, with its own login. Talks to the API at ODDSDAY_CONFIG.apiUrl (see config.js).
const API_URL = ((window.ODDSDAY_CONFIG && window.ODDSDAY_CONFIG.apiUrl) || '').replace(/\/$/, '');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { user: null, platforms: [], sub: null };
const isoLocal = o => { const d = new Date(); d.setDate(d.getDate() + o); return d.toLocaleDateString('en-CA'); };
const fmtOdds = n => n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2);
const time = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const started = p => p.status !== 'NS' || new Date(p.kickoff) <= new Date();
const empty = (title, sub) => `<div class="empty"><b>${esc(title)}</b><br>${esc(sub)}</div>`;
function toast(msg, ms = 2400) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); }

async function api(path, opts = {}) {
  let res;
  try { res = await fetch(API_URL + path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'include' }); }
  catch { throw new Error(API_URL ? `Can't reach the server at ${API_URL}. Check that the backend is running, API_URL is its public https address, and CORS_ORIGINS on the backend lists this site.` : "Can't reach the server. API_URL is not set for this site."); }
  const data = await res.json().catch(() => ({}));
  const isLogin = path === '/api/admin/login';
  if (res.status === 401 && !isLogin) { showLogin(); throw new Error('Please log in'); }
  if (res.status === 403 && !isLogin) { showDenied(); throw new Error('Admins only'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

// ---------- sign in ----------
const view = id => ['login', 'denied', 'console'].forEach(v => ($('#adm-' + v).hidden = v !== id));
function showLogin() { view('login'); }
function showDenied() { view('denied'); }
$('#adm-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#adm-form [type=submit]'); btn.disabled = true; $('#adm-form .form-error').textContent = '';
  const fd = new FormData(e.target);
  try { await api('/api/admin/login', { method: 'POST', body: { phone: fd.get('phone'), passcode: fd.get('passcode') } }); await boot(); }
  catch (err) { $('#adm-form .form-error').textContent = err.message; }
  btn.disabled = false;
});
$('#adm-form [name=phone]').addEventListener('input', e => { e.target.value = e.target.value.replace(/[^\d+\s\-()]/g, ''); });
for (const b of $$('[data-adm-logout]')) b.addEventListener('click', async () => { await fetch(API_URL + '/api/admin/logout', { method: 'POST', credentials: 'include' }); location.reload(); });

const pct = x => x == null ? '—' : Math.round(x * 100) + '%';
const CIRC = 2 * Math.PI * 42;

// Ring gauge. value 0..1; the ring sweeps in when first drawn.
function ring(value, centre, sub, color = 'url(#gold-grad)') {
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  return `<svg class="ring" viewBox="0 0 100 100" role="img" aria-label="${esc(sub)} ${esc(centre)}">
    <circle cx="50" cy="50" r="42" class="ring-track"/>
    <circle cx="50" cy="50" r="46.5" class="ring-ticks"/>
    <circle cx="50" cy="50" r="42" class="ring-bar" stroke="${color}" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}" data-to="${CIRC * (1 - v)}"/>
    <text x="50" y="50" class="ring-val">${esc(centre)}</text>
    <text x="50" y="66" class="ring-sub">${esc(sub)}</text></svg>`;
}
function sweepRings(root) {
  requestAnimationFrame(() => requestAnimationFrame(() =>
    $$('.ring-bar', root).forEach(c => (c.style.strokeDashoffset = c.dataset.to))));
}

// ---------- admin: booking codes ----------
// Market names as most Ghana bookmakers show them on the betslip.
const BOOK = {
  H: ['1X2', 'Home'], D: ['1X2', 'Draw'], A: ['1X2', 'Away'],
  '1X': ['Double Chance', 'Home or Draw'], X2: ['Double Chance', 'Draw or Away'], '12': ['Double Chance', 'Home or Away'],
  O15: ['Over/Under', 'Over 1.5'], U15: ['Over/Under', 'Under 1.5'], O25: ['Over/Under', 'Over 2.5'],
  U25: ['Over/Under', 'Under 2.5'], O35: ['Over/Under', 'Over 3.5'], U35: ['Over/Under', 'Under 3.5'],
  BTTS_Y: ['GG/NG', 'GG (Yes)'], BTTS_N: ['GG/NG', 'NG (No)'],
};

async function loadCodes() {
  const { days } = await api('/api/admin/tickets');
  const dayName = d => d === isoLocal(0) ? 'Today' : d === isoLocal(1) ? 'Tomorrow' : d;
  $('#codes').innerHTML = days.map(day => `<h2 class="section-head">${dayName(day.date)}</h2>` + (day.tickets.length ? day.tickets.map(t => {
    const live = t.legs.some(started);
    const count = Object.keys(t.codes).length;
    return `<form class="code-card" data-ticket="${t.id}">
      <div class="code-card-head"><h3>${esc(t.name)}</h3><span>${t.legs.length} games, total ${t.total_odds.toFixed(2)}, ${count} of ${state.platforms.length} codes added</span></div>
      <ol>${t.legs.map(l => { const [m, p] = BOOK[l.pick_code] || [l.market, l.pick];
        return `<li><b>${esc(l.home)} v ${esc(l.away)}</b> <span class="muted-inline">${esc(l.league_name)}, ${time(l.kickoff)}</span><br>${esc(m)}: <b>${esc(p)}</b> <span class="muted-inline">our odds ${l.odds.toFixed(2)}</span></li>`; }).join('')}</ol>
      <div class="code-grid">${state.platforms.map(p => `<label>${esc(p.name)}
        <input name="${p.key}" value="${esc(t.codes[p.key] || '')}" placeholder="Paste code" autocomplete="off" ${live ? 'readonly' : ''}></label>`).join('')}</div>
      <div class="code-save">
        ${count ? '<p class="locked">Locked: this ticket won\'t change when predictions refresh.</p>' : '<span></span>'}
        <span class="adm-user-btns">${live ? '<span class="muted-inline">Games started</span>' : '<button class="add solid" type="submit">Save codes</button>'}<button class="add danger" type="button" data-del-ticket="${t.id}">Delete ticket</button></span>
      </div>
    </form>`; }).join('') : '<div class="empty">No tickets for this day yet.</div>')).join('');
}

document.addEventListener('submit', async e => {
  const form = e.target.closest('[data-ticket]');
  if (!form) return;
  e.preventDefault();
  const codes = Object.fromEntries(state.platforms.map(p => [p.key, form.elements[p.key].value]));
  try {
    const r = await api(`/api/admin/tickets/${form.dataset.ticket}/codes`, { method: 'PUT', body: { codes } });
    toast(`Saved ${Object.keys(r.codes).length} codes`);
    loadCodes();
  } catch (err) { toast(err.message); }
});

// ---------- admin dashboard ----------
const ago = iso => {
  if (!iso) return '—';
  const t = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z').getTime();
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
  if (m < 1440) return Math.round(m / 60) + ' h ago'; return Math.round(m / 1440) + ' d ago';
};
// "0 6 * * *" -> "every day at 06:00", "15 * * * *" -> "every hour at :15"; anything else is shown as written.
function cronText(c) {
  const m = String(c).trim().split(/\s+/);
  if (m.length === 5 && /^\d+$/.test(m[0]) && /^\d+$/.test(m[1]) && m.slice(2).every(x => x === '*')) return `every day at ${m[1].padStart(2, '0')}:${m[0].padStart(2, '0')}`;
  if (m.length === 5 && /^\d+$/.test(m[0]) && m.slice(1).every(x => x === '*')) return `every hour at :${m[0].padStart(2, '0')}`;
  return c;
}
const admStat = (label, value, sub = '', cls = '') => `<div class="adm-stat ${cls}"><span>${esc(label)}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;

$$('.subnav button').forEach(b => b.addEventListener('click', () => setSub(b.dataset.sub)));
function setSub(sub) {
  state.sub = sub;
  $$('.subnav button').forEach(b => b.setAttribute('aria-selected', b.dataset.sub === sub));
  $$('[data-sub-panel]').forEach(p => (p.hidden = p.dataset.subPanel !== sub));
  if (sub === 'overview') loadOverview();
  if (sub === 'codes') loadCodes();
  if (sub === 'users') loadUsers();
  if (sub === 'activity') loadActivity();
  if (sub === 'settings') loadSettings();
}
function loadAdmin() { setSub(state.sub || 'overview'); }
$('#adm-refresh').addEventListener('click', () => setSub(state.sub || 'overview'));

async function loadOverview() {
  const el = $('#adm-overview');
  let o; try { o = await api('/api/admin/overview'); } catch (e) { el.innerHTML = empty('Could not load the dashboard.', e.message); return; }
  const pf = k => o.platformNames[k] || k;
  const attn = o.attention.map(a => `<li class="adm-attn ${a.level}"><span>${esc(a.text)}</span>${
    a.goto ? `<button class="link" data-adm-goto="${a.goto}">Open</button>` : a.action === 'run' ? '<button class="link" data-adm-run>Run now</button>' : ''}</li>`).join('');

  const day = (d, label) => {
    const rows = d.tickets.map(t => {
      const started = t.first_kickoff && t.first_kickoff <= o.now;
      const state_ = t.result !== 'pending' ? `<span class="badge ${t.result}">${t.result}</span>` : started ? '<span class="badge live">Started</span>'
        : t.codes ? `<span class="badge won">${t.codes} code${t.codes > 1 ? 's' : ''}</span>` : '<span class="badge void">No code</span>';
      return `<tr><td>${esc(t.name)}</td><td>${t.legs}</td><td>${fmtOdds(t.total_odds)}</td><td>${state_}</td></tr>`;
    }).join('');
    return `<div class="adm-day"><h4>${label} <span class="muted-inline">${d.games} games, ${d.picks} picks</span></h4>${
      d.tickets.length ? `<table><tr><th>Ticket</th><th>Games</th><th>Odds</th><th>Status</th></tr>${rows}</table>` : '<p class="muted-inline">No tickets built.</p>'}</div>`;
  };

  const maxPlat = Math.max(1, ...o.platforms.map(x => x.n));
  const plat = o.platforms.length ? o.platforms.sort((a, b) => b.n - a.n).map(x =>
    `<div class="adm-bar"><span>${esc(pf(x.key))}</span><i style="--w:${(x.n / maxPlat * 100).toFixed(0)}%"></i><b>${x.n}</b></div>`).join('') : '<p class="muted-inline">No users yet.</p>';
  const cover = o.codeCover.length ? o.codeCover.map(c => `${esc(pf(c.platform))}: <b>${c.n}</b>`).join(' · ') : 'No codes added yet';

  const tiers = o.tiers.map(t => `<div class="adm-tier t-${t.key}">
      ${ring(t.hitRate, pct(t.hitRate), 'hit rate', 'var(--c)')}
      <h4>${esc(t.label)}</h4><p>${t.won} won, ${t.lost} lost</p><p>${t.profit > 0 ? '+' : ''}${t.profit} units</p></div>`).join('');

  const sent = n => Object.values(n).reduce((a, b) => a + b, 0);
  const lp = o.runs.predict, ls = o.runs.settle;
  const runLine = (r, none) => r ? `<span class="badge ${r.ok ? 'won' : 'lost'}">${r.ok ? 'OK' : 'Failed'}</span> ${r.created_at ? ago(r.created_at) : esc(r.date || '')}` : none;

  const ico = d => `<svg class="kpi-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const kpi = (icon, label, value, sub, tone = '') => `<div class="kpi ${tone}">${ico(icon)}<span>${esc(label)}</span><b>${value}</b><small>${sub || '&nbsp;'}</small></div>`;
  const won = o.tiers.reduce((a, t) => a + t.won, 0), lost = o.tiers.reduce((a, t) => a + t.lost, 0);
  const units = o.tiers.reduce((a, t) => a + t.profit, 0);
  const todayT = o.days[0].tickets, booked = todayT.filter(t => t.codes).length;
  const allT = o.days.flatMap(d => d.tickets), needCodes = allT.filter(t => !t.codes && t.first_kickoff && t.first_kickoff > o.now).length;
  const badge = $('#adm-codes-badge'); badge.textContent = needCodes; badge.hidden = !needCodes;
  $('#adm-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const cov = Object.keys(o.platformNames).map(k => {
    const n = (o.codeCover.find(c => c.platform === k) || {}).n || 0, w = allT.length ? n / allT.length * 100 : 0;
    return `<div class="adm-bar"><span>${esc(pf(k))}</span><i style="--w:${w.toFixed(0)}%"></i><b>${n}/${allT.length}</b></div>`;
  }).join('');

  el.innerHTML = `
    ${attn ? `<ul class="adm-attn-list">${attn}</ul>` : '<div class="adm-allgood">✅ Everything looks good.</div>'}

    <div class="kpis">
      ${kpi('M3 20c.6-4 3.3-6 6-6s5.4 2 6 6M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'Users', o.users.total, o.users.day != null ? `+${o.users.day} today · +${o.users.week} this week` : `${o.users.admins} admin${o.users.admins === 1 ? '' : 's'}`)}
      ${kpi('M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z', 'Tickets today', `${booked}/${todayT.length}`, 'with booking codes', todayT.length && booked < todayT.length ? 'warn' : 'good')}
      ${kpi('M4 19V9M10 19V5M16 19v-7M22 19H2', 'Hit rate, 30 days', pct(won + lost ? won / (won + lost) : null), `${won} won · ${lost} lost · ${units > 0 ? '+' : ''}${units.toFixed(1)} units`, units >= 0 ? 'good' : 'bad')}
      ${kpi('M21 4 3 11l6 2 2 6 3-4 4 3z', 'Telegram', o.telegram.enabled ? o.users.telegram : '—', o.telegram.enabled ? `${sent(o.notifications.day)} alerts today · ${sent(o.notifications.week)} this week` : o.phone ? 'Server version only' : 'Not set up')}
    </div>

    <div class="adm-cols">
      <div class="adm-col">
        <div class="hud adm-block"><div class="hud-head"><h2>Today and tomorrow</h2><button class="link" data-adm-goto="codes">Booking codes</button></div>
          ${day(o.days[0], 'Today')}${day(o.days[1], 'Tomorrow')}</div>
        <div class="hud adm-block"><div class="hud-head"><h2>Results, 30 days</h2></div>
          <div class="adm-tiers">${tiers}</div>
          <p class="muted-inline adm-cover">Long bets: <b>${o.longs.won}</b> won, <b>${o.longs.lost}</b> lost</p></div>
      </div>
      <div class="adm-col">
        <div class="hud adm-block"><div class="hud-head"><h2>Code coverage</h2></div>${cov}
          <p class="muted-inline adm-cover">Tickets with a code, by bookmaker</p></div>
        <div class="hud adm-block"><div class="hud-head"><h2>Users by bookmaker</h2></div>${plat}</div>
        <div class="hud adm-block"><div class="hud-head"><h2>System health</h2></div>
          <dl class="adm-dl">
            <div><dt>Last prediction run</dt><dd>${runLine(lp, 'Not yet')}${lp && lp.message ? `<small>${esc(lp.message)}</small>` : ''}</dd></div>
            <div><dt>Last settle</dt><dd>${runLine(ls, o.phone ? 'Runs when the app opens' : 'Not yet')}</dd></div>
            <div><dt>Failed runs, 24 h</dt><dd>${o.runs.failed24 ? `<span class="badge lost">${o.runs.failed24}</span>` : '0'}</dd></div>
            <div><dt>Data source</dt><dd>${o.api.mode === 'live' ? `Live · ${o.api.calls} API calls` : 'Sample games'}</dd></div>
            ${o.telegram.enabled && o.telegram.bot ? `<div><dt>Telegram bot</dt><dd>@${esc(o.telegram.bot)}</dd></div>` : ''}
          </dl></div>
      </div>
    </div>`;
}

document.addEventListener('click', e => {
  const g = e.target.closest('[data-adm-goto]');
  if (g) return setSub(g.dataset.admGoto);
  if (e.target.closest('[data-adm-run]')) return adminRun();
});

let usersCache = [];
async function loadUsers() {
  try { usersCache = (await api('/api/admin/users')).users; } catch (e) { $('#adm-users').innerHTML = empty('Could not load users.', e.message); return; }
  fillPlatformSelects(); renderUsers();
}
function renderUsers() {
  const q = $('#adm-search').value.trim().toLowerCase();
  const list = usersCache.filter(u => !q || String(u.phone || '').includes(q.replace(/[\s()-]/g, '')) || u.name.includes(q));
  $('#adm-users').innerHTML = (usersCache.length ? `<p class="muted-inline">${list.length} of ${usersCache.length} users</p>` : '') +
    (list.length ? list.map(u => `<article class="adm-user">
      <div class="adm-avatar">${esc(String(u.phone || '?').slice(-2))}</div>
      <div class="adm-user-main">
        <b>${esc(u.name)}</b>${u.is_admin ? ' <span class="badge live">Admin</span>' : ''}
        
        <div class="meta"><span>${esc((state.platforms.find(p => p.key === u.platform) || {}).name || u.platform)}</span>
          <span>${u.picks} saved pick${u.picks === 1 ? '' : 's'}</span>${u.telegram ? '<span>Telegram ✓</span>' : ''}${u.created_at ? `<span>Joined ${ago(u.created_at)}</span>` : ''}</div>
      </div>
      ${u.id === state.user.id ? '<span class="muted-inline">You</span>'
        : `<div class="adm-user-btns"><button class="add" data-make-admin="${u.id}" data-to="${u.is_admin ? 0 : 1}">${u.is_admin ? 'Remove admin' : 'Make admin'}</button><button class="add danger" data-del-user="${u.id}">Delete</button></div>`}
    </article>`).join('') : empty(usersCache.length ? 'No users match your search.' : 'No users yet.', ''));
}
$('#adm-search').addEventListener('input', renderUsers);
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-make-admin]');
  if (!b) return;
  const make = b.dataset.to === '1', u = usersCache.find(x => x.id === +b.dataset.makeAdmin);
  if (!confirm(make ? `Give ${u.name} admin access? They will be able to edit booking codes and see all users.` : `Remove admin access from ${u.name}?`)) return;
  try { await api(`/api/admin/users/${u.id}/admin`, { method: 'PUT', body: { isAdmin: make } }); toast(make ? 'Admin access given' : 'Admin access removed'); loadUsers(); }
  catch (err) { toast(err.message); }
});

async function loadActivity() {
  let runs; try { runs = (await api('/api/admin/runs')).runs; } catch (e) { $('#adm-runs').innerHTML = empty('Could not load activity.', e.message); return; }
  try {
    const o = await api('/api/admin/overview');
    $('#adm-schedule').textContent = o.schedule ? `Predictions run ${cronText(o.schedule.predict)} and finished games are settled ${cronText(o.schedule.settle)} (${o.schedule.timezone} time).` : 'On the phone version, predictions and settling run each time the app is opened.';
  } catch { /* schedule line is optional */ }
  $('#adm-runs').innerHTML = runs.length ? `<div class="record-wide"><h3>Recent runs</h3><table><tr><th>When</th><th>What</th><th>Result</th></tr>${runs.map(r =>
    `<tr><td>${r.created_at ? ago(r.created_at) : '—'}</td><td>${r.kind === 'predict' ? 'Predict' : 'Settle'}${r.date ? ' ' + esc(r.date) : ''}</td>
      <td><span class="badge ${r.ok ? 'won' : 'lost'}">${r.ok ? 'OK' : 'Failed'}</span> <span class="muted-inline">${esc(r.message || '')}</span></td></tr>`).join('')}</table></div>`
    : empty('No runs yet.', 'Runs appear here after the first prediction job.');
  try {
    const { log } = await api('/api/admin/log');
    $('#adm-log').innerHTML = log.length ? `<div class="record-wide"><h3>Admin changes</h3><table><tr><th>When</th><th>Who</th><th>What</th></tr>${log.map(l =>
      `<tr><td>${ago(l.created_at)}</td><td>${esc(l.admin)}</td><td>${esc(l.action)} <span class="muted-inline">${esc(l.detail || '')}</span></td></tr>`).join('')}</table></div>` : '';
  } catch { /* the log is optional */ }
}
async function adminRun() {
  toast('Refreshing predictions…');
  try { await api('/api/admin/run', { method: 'POST' }); toast('Predictions refreshed'); setSub(state.sub || 'overview'); }
  catch (e) { toast(e.message); }
}
$('#adm-run').addEventListener('click', adminRun);
$('#adm-settle').addEventListener('click', async () => {
  toast('Settling…');
  try { const r = await api('/api/admin/settle', { method: 'POST' }); toast(`${r.updated || 0} picks settled`); loadActivity(); }
  catch (e) { toast(e.message); }
});


// ---------- admin: settings ----------
const BANDS = ['low', 'medium', 'high'];
const SHOWN_IN = [['long', 'Long bets'], ['low', 'Low odds tab'], ['medium', 'Medium odds tab'], ['high', 'High odds tab']];
const TIMEZONES = ['Africa/Accra', 'Africa/Lagos', 'Africa/Nairobi', 'Africa/Johannesburg', 'Europe/London', 'UTC'];
const SETTLE_PRESETS = [['*/15 * * * *', 'Every 15 minutes'], ['*/30 * * * *', 'Every 30 minutes'], ['15 * * * *', 'Every hour'], ['15 */2 * * *', 'Every 2 hours']];
let S = null;       // settings as last loaded from the server
let draft = {};     // rows being edited in the list sections (leagues, accas, platforms)
const slugify = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
const pctVal = p => (p === '' || p == null ? '' : Math.round(p * 1000) / 10);
const toProb = v => (v === '' ? '' : Number(v) / 100);
const fld = (label, name, value, attrs = '', cls = '') => `<label class="${cls}">${esc(label)}<input data-f="${name}" value="${esc(value ?? '')}" ${attrs}></label>`;
const sourceNote = x => x.set ? `set ${x.source === 'dashboard' ? 'here' : 'on the server'} (${esc(x.hint)})` : 'not set';

function rowsOf(kind) {
  return $$(`[data-rows="${kind}"] [data-row]`).map(r => {
    const o = { _key: r.dataset.key || '' };
    $$('[data-f]', r).forEach(i => { o[i.dataset.f] = i.type === 'checkbox' ? i.checked : i.value; });
    return o;
  });
}
// Unique, stable keys for new rows (existing rows keep theirs).
function withKeys(rows) {
  const taken = new Set(rows.map(r => r._key).filter(Boolean));
  return rows.map(r => {
    if (r._key) return r._key;
    let k = slugify(r.name) || 'item', n = 2, base = k;
    while (taken.has(k)) k = `${base.slice(0, 20)}_${n++}`;
    taken.add(k); return k;
  });
}
const READ = {
  leagues: () => rowsOf('leagues').map(r => ({ id: r.id, name: r.name, country: r.country })),
  platforms: () => { const rows = rowsOf('platforms'), keys = withKeys(rows); return rows.map((r, i) => ({ key: keys[i], name: r.name, url: r.url })); },
  accas: () => { const rows = rowsOf('accas'), keys = withKeys(rows);
    return rows.map((r, i) => ({ key: keys[i], group: r.group, name: r.name, target: r.target, minLegs: r.minLegs, maxLegs: r.maxLegs,
      pool: BANDS.filter(b => r['pool_' + b]), minProb: toProb(r.minProb) })); },
};
const BLANK = {
  leagues: () => ({ id: '', name: '', country: '' }),
  platforms: () => ({ key: '', name: '', url: 'https://' }),
  accas: () => ({ key: '', group: 'long', name: '', target: 50, minLegs: 8, maxLegs: 12, pool: [...BANDS], minProb: 0.4 }),
};
const ROW = {
  leagues: (l, i) => `<div class="set-row" data-row>${fld('League id', 'id', l.id, 'type="number" min="1"')}${fld('Name', 'name', l.name)}${fld('Country', 'country', l.country)}
    <button class="add danger" type="button" data-del="leagues:${i}">Remove</button></div>`,
  platforms: (p, i) => `<div class="set-row" data-row data-key="${esc(p.key)}">${fld('Bookmaker', 'name', p.name)}${fld('"Open" button link', 'url', p.url, 'type="url"', 'wide')}
    <button class="add danger" type="button" data-del="platforms:${i}">Remove</button></div>`,
  accas: (a, i) => `<div class="set-row" data-row data-key="${esc(a.key)}">${fld('Ticket name', 'name', a.name, '', 'wide')}
    <label>Shown in<select data-f="group">${SHOWN_IN.map(([v, l]) => `<option value="${v}" ${a.group === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    ${fld('Target odds', 'target', a.target, 'type="number" step="any" min="1.5"')}${fld('Fewest games', 'minLegs', a.minLegs ?? '', 'type="number" min="2" placeholder="any"')}
    ${fld('Most games', 'maxLegs', a.maxLegs, 'type="number" min="2"')}${fld('Lowest chance per game, %', 'minProb', pctVal(a.minProb), 'type="number" min="0" max="100"')}
    <div class="pool"><span class="muted-inline">Games from:</span>${BANDS.map(b => `<label><input type="checkbox" data-f="pool_${b}" ${(a.pool || []).includes(b) ? 'checked' : ''}> ${esc(S.tiers[b].label)}</label>`).join('')}</div>
    <button class="add danger" type="button" data-del="accas:${i}">Remove</button></div>`,
};
const rowsHtml = kind => draft[kind].map(ROW[kind]).join('') || '<p class="muted-inline">Nothing here yet.</p>';

const setCard = (id, title, note, body, actions, keys = []) => `<section class="hud set-card" id="set-${id}">
  <div class="hud-head"><h2>${esc(title)}</h2>${keys.some(k => S.overridden.includes(k)) ? '<span class="badge live">Changed here</span>' : ''}</div>
  ${note ? `<p class="muted-inline">${note}</p>` : ''}${body}
  <div class="set-actions">${actions}${keys.some(k => S.overridden.includes(k)) ? `<span class="spacer"></span><button class="add" type="button" data-reset="${keys.join(',')}">Reset to server default</button>` : ''}</div></section>`;
const saveBtn = (what, label = 'Save') => `<button class="add solid" type="button" data-save="${what}">${label}</button>`;

function renderSettings() {
  const g = S.general, sc = S.secrets;
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(g.predictCron);
  const presets = SETTLE_PRESETS.some(p => p[0] === g.settleCron) ? SETTLE_PRESETS : [...SETTLE_PRESETS, [g.settleCron, `Custom (${g.settleCron})`]];
  const tierRows = BANDS.map(k => { const t = S.tiers[k]; return `<div class="set-row" data-row data-key="${k}">${fld('Band name', 'label', t.label)}${fld('Lowest odds', 'min', t.min, 'type="number" step="any"')}
    ${fld('Highest odds', 'max', t.max, 'type="number" step="any"')}${fld('Lowest chance, %', 'minProb', pctVal(t.minProb), 'type="number" min="0" max="100"')}</div>`; }).join('');
  const so = S.serverOnly;
  $('#adm-settings').innerHTML = [
    setCard('data', 'Data and alerts', `API-Football key ${sourceNote(sc.apiKey)}. Telegram bot token ${sourceNote(sc.telegramToken)}. Leave a key box empty to keep what is saved. Save first, then press Test.`,
      `<div class="set-grid"><label>API-Football key<input data-f="apiKey" type="password" autocomplete="off" placeholder="${sc.apiKey.set ? 'Leave empty to keep the current key' : 'Paste your key'}"></label>
        ${fld('Odds bookmaker id on API-Football', 'bookmakerId', g.bookmakerId, 'type="number" min="1"')}
        <label>Telegram bot token<input data-f="telegramToken" type="password" autocomplete="off" placeholder="${sc.telegramToken.set ? 'Leave empty to keep the current token' : 'From @BotFather'}"></label>
        ${fld('Site address (used in Telegram links)', 'siteUrl', g.siteUrl, 'type="url" placeholder="https://app.yoursite.com"')}</div>`,
      `${saveBtn('data')}<button class="add" type="button" data-test="apiKey">Test API key</button><button class="add" type="button" data-test="telegram">Test Telegram</button>
        ${sc.apiKey.source === 'dashboard' ? '<button class="add danger" type="button" data-clear="apiKey">Remove saved API key</button>' : ''}
        ${sc.telegramToken.source === 'dashboard' ? '<button class="add danger" type="button" data-clear="telegramToken">Remove saved bot token</button>' : ''}`,
      ['siteUrl', 'bookmakerId', 'apiKey', 'telegramToken']),
    setCard('schedule', 'Schedule', 'When predictions are made and when finished games are settled. Changes apply immediately, with no restart.',
      `<div class="set-grid"><label>Time zone<input data-f="timezone" value="${esc(g.timezone)}" list="adm-tz"><datalist id="adm-tz">${TIMEZONES.map(t => `<option value="${t}">`).join('')}</datalist></label>
        ${m ? `<label>Predictions run every day at<input data-f="predictTime" type="time" value="${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}"></label>` : fld('Predictions schedule (custom)', 'predictCron', g.predictCron)}
        <label>Settle finished games<select data-f="settleCron">${presets.map(([v, l]) => `<option value="${esc(v)}" ${v === g.settleCron ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>`,
      saveBtn('schedule'), ['timezone', 'predictCron', 'settleCron']),
    setCard('tiers', 'Odds bands', 'The three daily categories. A pick belongs to a band when its odds fall between the lowest and highest odds and its chance is at least the lowest chance.',
      `<div data-rows="tiers">${tierRows}</div>`, saveBtn('tiers'), ['tiers']),
    setCard('accas', 'Tickets', 'The accumulators built each day. Top tickets stop once the target odds are reached. Long bets need many games: set the fewest games. Removing a ticket here also stops it being built.',
      `<div data-rows="accas">${rowsHtml('accas')}</div>`, `${saveBtn('accas')}<button class="add" type="button" data-add="accas">Add ticket</button>`, ['accas']),
    setCard('platforms', 'Bookmakers', 'Where users send their bets. Each ticket can hold one booking code per bookmaker. Users on a bookmaker you remove move to the first one in the list.',
      `<div data-rows="platforms">${rowsHtml('platforms')}</div>`, `${saveBtn('platforms')}<button class="add" type="button" data-add="platforms">Add bookmaker</button>`, ['platforms']),
    setCard('leagues', 'Leagues', 'Competitions that get predictions. Use the league id from API-Football. Sample games only exist for the original leagues.',
      `<div data-rows="leagues">${rowsHtml('leagues')}</div>`, `${saveBtn('leagues')}<button class="add" type="button" data-add="leagues">Add league</button>`, ['leagues']),
    setCard('security', 'Admin passcode', `Needed with an admin phone number to open this console. Currently ${sc.passcode.set ? `set ${sc.passcode.source === 'dashboard' ? 'here' : 'on the server'}` : '<b>not set</b>, so a guessed admin number is enough to get in'}. A passcode saved here replaces the server one. Consoles already signed in stay signed in for up to 12 hours.`,
      `<div class="set-grid"><label>New passcode<input data-f="passcode" type="password" autocomplete="new-password" placeholder="6 or more characters"></label></div>`,
      `${saveBtn('passcode', 'Save passcode')}${sc.passcode.source === 'dashboard' ? '<button class="add danger" type="button" data-save="passcode-clear">Remove saved passcode</button>' : ''}`),
    `<section class="hud set-card"><div class="hud-head"><h2>Set on the server only</h2></div>
      <p class="muted-inline">These can lock everyone out if edited by mistake, so they are changed in your hosting variables, not here.</p>
      <dl class="set-fixed"><dt>Allowed websites</dt><dd>${so.corsOrigins.map(esc).join(', ')}</dd><dt>Cookie mode</dt><dd>${esc(so.cookieSameSite)}</dd>
        <dt>Session secret</dt><dd>${so.sessionSecretOk ? 'Set' : '<b>Weak: set JWT_SECRET</b>'}</dd><dt>Database file</dt><dd>${esc(so.dbFile)}</dd><dt>Port</dt><dd>${so.port}</dd>
        <dt>Admin numbers in ADMIN_PHONES</dt><dd>${so.adminPhones}</dd></dl></section>`,
  ].join('');
}
function resetDraft() { draft = { leagues: S.leagues, platforms: S.platforms, accas: S.accas }; }
async function loadSettings() {
  try { S = await api('/api/admin/settings'); } catch (e) { $('#adm-settings').innerHTML = empty('Could not load settings.', e.message); return; }
  state.platforms = S.platforms; resetDraft(); renderSettings();
}
async function putSettings(patch, msg) {
  S = await api('/api/admin/settings', { method: 'PUT', body: patch });
  state.platforms = S.platforms; resetDraft(); renderSettings(); toast(msg);
}
const val = name => { const i = $(`#adm-settings [data-f="${name}"]`); return i ? i.value.trim() : ''; };

document.addEventListener('click', async e => {
  const b = e.target.closest('#adm-settings button');
  if (!b) return;
  try {
    const d = b.dataset;
    if (d.add) { for (const k of Object.keys(READ)) if (k === d.add) { draft[k] = READ[k](); draft[k].push(BLANK[k]()); $(`[data-rows="${k}"]`).innerHTML = rowsHtml(k); } }
    else if (d.del) { const [k, i] = d.del.split(':'); draft[k] = READ[k](); draft[k].splice(+i, 1); $(`[data-rows="${k}"]`).innerHTML = rowsHtml(k); }
    else if (d.test) { b.disabled = true; try { const r = await api('/api/admin/settings/test', { method: 'POST', body: { target: d.test } }); toast(r.message, 6000); } finally { b.disabled = false; } }
    else if (d.clear) { if (confirm('Remove the saved value? The server setting (if any) will be used instead.')) await putSettings({ [d.clear]: '' }, 'Removed'); }
    else if (d.reset) { if (!confirm('Go back to the server default for this section? Your saved changes here will be lost.')) return;
      for (const k of d.reset.split(',')) if (S.overridden.includes(k)) S = await api('/api/admin/settings/' + k, { method: 'DELETE' });
      state.platforms = S.platforms; resetDraft(); renderSettings(); toast('Back to the server default'); }
    else if (d.save === 'data') {
      const patch = { bookmakerId: val('bookmakerId'), siteUrl: val('siteUrl') };
      if (val('apiKey')) patch.apiKey = val('apiKey'); if (val('telegramToken')) patch.telegramToken = val('telegramToken');
      await putSettings(patch, 'Saved');
    }
    else if (d.save === 'schedule') {
      const t = val('predictTime').match(/^(\d{1,2}):(\d{2})$/);
      await putSettings({ timezone: val('timezone'), predictCron: t ? `${+t[2]} ${+t[1]} * * *` : val('predictCron'), settleCron: val('settleCron') }, 'Schedule saved');
    }
    else if (d.save === 'tiers') {
      const tiers = {}; for (const r of rowsOf('tiers')) tiers[r._key] = { label: r.label, min: r.min, max: r.max, minProb: toProb(r.minProb) };
      await putSettings({ tiers }, 'Odds bands saved');
    }
    else if (d.save === 'passcode' || d.save === 'passcode-clear') {
      const p = d.save === 'passcode' ? val('passcode') : '';
      if (d.save === 'passcode' && !p) return toast('Type a new passcode first');
      S = await api('/api/admin/settings/passcode', { method: 'PUT', body: { passcode: p } }); state.platforms = S.platforms; resetDraft(); renderSettings();
      toast(p ? 'Passcode saved' : 'Saved passcode removed');
    }
    else if (READ[d.save]) await putSettings({ [d.save]: READ[d.save]() }, 'Saved');
  } catch (err) { toast(err.message, 6000); }
});

// ---------- admin: add users, message users, delete tickets ----------
function fillPlatformSelects() {
  const opts = state.platforms.map(p => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('');
  $('#adm-adduser [name=platform]').innerHTML = opts;
  $('#adm-broadcast [name=platform]').innerHTML = '<option value="all">Everyone on Telegram</option>' + state.platforms.map(p => `<option value="${esc(p.key)}">${esc(p.name)} users</option>`).join('');
}
$('#adm-adduser [name=phone]').addEventListener('input', e => { e.target.value = e.target.value.replace(/[^\d+\s\-()]/g, ''); });
$('#adm-adduser').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target.elements;
  try { await api('/api/admin/users', { method: 'POST', body: { phone: f.phone.value, platform: f.platform.value, isAdmin: f.isAdmin.checked } }); f.phone.value = ''; f.isAdmin.checked = false; toast('User added'); loadUsers(); }
  catch (err) { toast(err.message, 5000); }
});
$('#adm-broadcast').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target.elements;
  if (!f.message.value.trim()) return toast('Write a message first');
  if (!confirm('Send this message now? It cannot be taken back.')) return;
  try { const r = await api('/api/admin/broadcast', { method: 'POST', body: { message: f.message.value, platform: f.platform.value } }); f.message.value = ''; toast(`Sent to ${r.sent} of ${r.total}`, 4000); loadActivity(); }
  catch (err) { toast(err.message, 5000); }
});
document.addEventListener('click', async e => {
  const du = e.target.closest('[data-del-user]'), dt = e.target.closest('[data-del-ticket]');
  try {
    if (du) {
      const u = usersCache.find(x => x.id === +du.dataset.delUser);
      if (!confirm(`Delete ${u.name}? Their saved picks and alert history are removed too. They can sign up again.`)) return;
      await api('/api/admin/users/' + u.id, { method: 'DELETE' }); toast('User deleted'); loadUsers();
    }
    if (dt) {
      const name = dt.closest('form').querySelector('h3').textContent;
      if (!confirm(`Delete "${name}"? Any booking codes on it are lost. It comes back on the next refresh only if it is still listed in Settings.`)) return;
      await api('/api/admin/tickets/' + dt.dataset.delTicket, { method: 'DELETE' }); toast('Ticket deleted'); loadCodes();
    }
  } catch (err) { toast(err.message, 5000); }
});


async function boot() {
  let me;
  try { me = await api('/api/admin/me'); }
  catch (err) {
    // 401 already showed the login form. Anything else (API unreachable, CORS) used to leave a blank page: show why instead.
    if (err.message !== 'Please log in' && err.message !== 'Admins only') { showLogin(); $('#adm-form .form-error').textContent = err.message; }
    return;
  }
  if (!me.user.isAdmin) return showDenied();
  state.user = me.user; state.platforms = me.platforms; state.passcodeSet = me.passcodeSet;
  view('console'); loadAdmin();
}
boot();
