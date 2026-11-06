// OddsDay public app — plain JavaScript, no build step.
// Talks to the API at ODDSDAY_CONFIG.apiUrl (see config.js).
const API_URL = ((window.ODDSDAY_CONFIG && window.ODDSDAY_CONFIG.apiUrl) || '').replace(/\/$/, '');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { user: null, date: null, tier: 'low', data: null, view: 'home', dash: null };

async function api(path, opts = {}) {
  // Standalone phone app: the backend runs inside the page.
  if (window.LocalAPI) {
    const r = await window.LocalAPI.request(opts.method || 'GET', path, opts.body);
    if (r.status === 401 && path !== '/api/login') { showAuth(); throw new Error('Please log in'); }
    if (r.status >= 400) throw new Error(r.data.error || 'Something went wrong. Try again.');
    return r.data;
  }
  const res = await fetch(API_URL + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showAuth(); throw new Error('Please log in'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2400);
}

// ---------- dates ----------
function isoLocal(offset) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA');
}
// Chance of a ticket winning: long bets are tiny percentages, so show more detail for them.
const chance = p => (p * 100).toFixed(p < 0.01 ? 2 : p < 0.05 ? 1 : 0) + '%';
const fmtOdds = n => n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2);
const time = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const started = p => p.status !== 'NS' || new Date(p.kickoff) <= new Date();

// ---------- auth ----------
let authMode = 'register';
function setAuthMode(mode) {
  authMode = mode;
  const reg = mode === 'register';
  $$('.auth-switch button').forEach(b => b.setAttribute('aria-selected', b.dataset.mode === mode));
  $('#auth-title').textContent = reg ? 'Create your free account' : 'Welcome back';
  $('#auth-sub').textContent = reg ? 'Just your phone number. No password, no email.' : 'Enter your phone number to log in.';
  $('#auth-form [type=submit]').textContent = reg ? 'Sign up' : 'Log in';
  $('#auth-alt-text').textContent = reg ? 'Already have an account?' : 'New to OddsDay?';
  $('#auth-alt').textContent = reg ? 'Log in' : 'Sign up';
  $('.form-error').textContent = '';
}
$('#auth-alt').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
$('#auth-form [name=phone]').addEventListener('input', e => { e.target.value = e.target.value.replace(/[^\d+\s\-()]/g, ''); });
$$('.auth-switch button').forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));

$('#auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target), btn = $('#auth-form [type=submit]');
  btn.disabled = true; $('.form-error').textContent = '';
  try {
    const body = { phone: f.get('phone') };
    const { user } = await api(authMode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body });
    state.user = user; await startApp();
  } catch (err) { $('.form-error').textContent = err.message; }
  btn.disabled = false;
});

function showAuth() { $('#app-view').hidden = true; $('#auth-view').hidden = false; }

// ---------- shell ----------
async function startApp() {
  const me = await api('/api/me');
  state.user = me.user;
  state.platforms = me.platforms;
  state.platform = me.user.platform;
  renderPlatforms();
  $('#auth-view').hidden = true; $('#app-view').hidden = false;
  $('#demo-pill').hidden = !me.demo;
  $('#top-date').textContent = new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  $('#avatar').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M4.5 20c.8-4 3.7-6 7.5-6s6.7 2 7.5 6"/></svg>';
  $('#menu-name').textContent = state.user.name;
  $('#tg-open').hidden = !me.telegram; // server version only, and only when the bot is set up
  showView('home');
  refreshSlipCount();
}

$$('.tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
function showView(view) {
  state.view = view;
  document.body.dataset.view = view;
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('[data-panel]').forEach(p => (p.hidden = p.dataset.panel !== view));
  if (view === 'slip') loadSlip();
  if (view === 'record') loadRecord();
  if (view === 'picks') state.date ? loadDay(state.date) : loadDay(isoLocal(0), true);
  if (view === 'home') loadDash();
  window.scrollTo(0, 0);
}

$('#menu-btn').addEventListener('click', e => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; });
document.addEventListener('click', e => { if (!$('#menu').contains(e.target)) $('#menu').hidden = true; });
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.reload(); });

// ---------- Telegram alerts ----------
const tgDialog = $('#tg-dialog');
let tgTimer = null;

function tgRender(t, linkUrl) {
  const body = $('#tg-body');
  if (!t.linked) {
    body.innerHTML = `<p class="muted">Get a message on Telegram when the morning picks are ready, and when a booking code is added for your bookmaker.</p>
      ${linkUrl ? `<a class="btn-primary tg-link" href="${esc(linkUrl)}" target="_blank" rel="noopener">Open Telegram and tap Start</a>
        <p class="fineprint">Waiting for you to tap Start in Telegram…</p>`
        : '<button class="btn-primary" id="tg-connect" type="button">Connect Telegram</button>'}`;
    const c = $('#tg-connect');
    if (c) c.addEventListener('click', tgConnect);
    return;
  }
  body.innerHTML = `<p class="tg-on">✅ Telegram is connected.</p>
    <label class="tg-opt"><input type="checkbox" data-tg="notifyPicks" ${t.notifyPicks ? 'checked' : ''}> Morning picks are ready</label>
    <label class="tg-opt"><input type="checkbox" data-tg="notifyCodes" ${t.notifyCodes ? 'checked' : ''}> Booking code added for my bookmaker</label>
    <button class="add tg-off" id="tg-off" type="button">Disconnect Telegram</button>`;
  $$('[data-tg]', body).forEach(cb => cb.addEventListener('change', async () => {
    try { await api('/api/me/telegram', { method: 'PUT', body: { [cb.dataset.tg]: cb.checked } }); toast('Saved'); }
    catch (err) { cb.checked = !cb.checked; toast(err.message); }
  }));
  $('#tg-off').addEventListener('click', async () => {
    try { tgRender(await api('/api/me/telegram', { method: 'DELETE' })); toast('Telegram disconnected'); } catch (err) { toast(err.message); }
  });
}

async function tgConnect() {
  try {
    const { url } = await api('/api/me/telegram/link', { method: 'POST' });
    tgRender({ linked: false }, url);
    // Wait for the user to tap Start in Telegram, then switch to the settings view.
    clearInterval(tgTimer);
    tgTimer = setInterval(async () => {
      if (!tgDialog.open) return clearInterval(tgTimer);
      try { const t = await api('/api/me/telegram'); if (t.linked) { clearInterval(tgTimer); tgRender(t); toast('Telegram connected'); } } catch { /* keep waiting */ }
    }, 3000);
  } catch (err) { toast(err.message); }
}

$('#tg-open').addEventListener('click', async () => {
  $('#menu').hidden = true;
  try { tgRender(await api('/api/me/telegram')); } catch (err) { return toast(err.message); }
  tgDialog.showModal();
});
tgDialog.addEventListener('close', () => clearInterval(tgTimer));
$('.tg-close', tgDialog).addEventListener('click', () => tgDialog.close());
tgDialog.addEventListener('click', e => { if (e.target === tgDialog) tgDialog.close(); });

// ---------- picks ----------
const DAYS = [[-1, 'Yesterday'], [0, 'Today'], [1, 'Tomorrow']];
function renderDays() {
  $('#days').innerHTML = DAYS.map(([o, label]) =>
    `<button data-date="${isoLocal(o)}" class="${isoLocal(o) === state.date ? 'active' : ''}">${label}</button>`).join('');
  $$('#days button').forEach(b => b.addEventListener('click', () => loadDay(b.dataset.date)));
}

$$('#tier-tabs button').forEach(b => b.addEventListener('click', () => { state.tier = b.dataset.tier; renderPicks(); }));

async function loadDay(date, autoPick = false) {
  state.date = date;
  renderDays();
  state.data = await api('/api/predictions?date=' + date);
  // Late in the day every game may have kicked off: jump to tomorrow's picks.
  if (autoPick) {
    const all = Object.values(state.data.tiers).flat();
    if (!all.some(p => !started(p))) {
      const tmr = await api('/api/predictions?date=' + isoLocal(1));
      if (Object.values(tmr.tiers).flat().length) { state.date = isoLocal(1); state.data = tmr; renderDays(); }
    }
  }
  renderPicks();
}

function stars(n) { return `<span class="stars" aria-label="Confidence ${n} of 5">${'●'.repeat(n)}<span class="off">${'●'.repeat(5 - n)}</span></span>`; }

function statusBit(p) {
  if (p.result === 'won' || p.result === 'lost' || p.result === 'void') {
    const score = p.home_goals != null ? `<span class="score">${p.home_goals}–${p.away_goals}</span>` : '';
    return `${score} <span class="badge ${p.result}">${p.result === 'won' ? 'Won' : p.result === 'lost' ? 'Lost' : 'Void'}</span>`;
  }
  if (started(p)) return `<span class="badge live">${p.status === 'NS' ? 'Started' : esc(p.status)}</span>`;
  return `<span>${time(p.kickoff)}</span>`;
}

function addButton(p) {
  if (p.saved) return `<button class="add saved" data-remove="${p.id}" aria-label="Remove from slip">On slip ✓</button>`;
  if (started(p)) return `<button class="add" disabled>Closed</button>`;
  return `<button class="add" data-add="${p.id}">Add to slip</button>`;
}

function pickRow(p, { showLeague = false } = {}) {
  return `<article class="pick t-${p.tier}">
    <div class="match">${esc(p.home)}<span class="vs">v</span>${esc(p.away)}</div>
    <div class="tip">${esc(p.market)}: <b>${esc(p.pick)}</b></div>
    <div class="meta">${showLeague ? `<span>${esc(p.league_name)}</span>` : ''}${statusBit(p)}
      <span>Chance ${Math.round(p.probability * 100)}%</span>${stars(p.confidence)}
      ${p.odds_source === 'model' ? '<span title="No bookmaker price yet; this is our estimated fair price">est. odds</span>' : ''}</div>
    <div class="odds"><span class="num">${p.odds.toFixed(2)}</span>${addButton(p)}</div>
  </article>`;
}

function renderPicks() {
  $$('#tier-tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tier === state.tier));
  const d = state.data, list = $('#picks-list');
  const count = d.tiers.low.length + d.tiers.medium.length + d.tiers.high.length;
  const games = new Set(Object.values(d.tiers).flat().map(p => p.fixture_id)).size;
  $('#day-summary').textContent = games ? `${games} games predicted` : '';

  if (state.tier === 'long') {
    const longs = d.accas.filter(a => a.grp === 'long');
    list.innerHTML = longs.length ? longs.map(ticket).join('') : empty('No long bets for this day yet.', 'They are built each morning once enough games have prices.');
  } else {
    const top = d.accas.find(a => a.grp === state.tier);
    const rows = [...d.tiers[state.tier]].sort((a, b) => b.confidence - a.confidence || a.kickoff.localeCompare(b.kickoff));
    if (!rows.length) {
      list.innerHTML = count ? empty('No picks in this odds range for this day.', 'Try another category.')
        : empty('No predictions for this day yet.', 'New picks are published every morning for the day\'s games.');
    } else {
      const byLeague = {};
      rows.forEach(r => (byLeague[r.league_name] ||= []).push(r));
      list.innerHTML = (top ? ticket(top) + `<h2 class="section-head">All ${state.tier}-odds picks</h2>` : '') +
        Object.entries(byLeague).map(([league, ps]) =>
        `<h3 class="league-head">${esc(league)}</h3>` + ps.map(p => pickRow(p)).join('')).join('');
    }
  }
}

function empty(title, sub) { return `<div class="empty"><b>${esc(title)}</b><br>${esc(sub)}</div>`; }

function legRow(l) {
  return `<li>
      <div class="match">${esc(l.home)}<span class="vs">v</span>${esc(l.away)}</div>
      <div class="meta"><span>${esc(l.market)}: <b>${esc(l.pick)}</b></span><span>${esc(l.league_name)}</span>${statusBit(l)}</div>
      <span class="leg-odds">${l.odds.toFixed(2)}</span></li>`;
}

function ticket(a) {
  const open = a.legs.some(l => !started(l) && !l.saved);
  const resultBadge = a.result !== 'pending' ? `<span class="badge ${a.result}">${a.result === 'won' ? 'Won' : a.result === 'lost' ? 'Lost' : 'Void'}</span>` : '';
  // Long bets can have 15+ games: show the first few and tuck the rest behind a toggle.
  const SHOW = 5, big = a.legs.length > SHOW + 2;
  const legs = big
    ? a.legs.slice(0, SHOW).map(legRow).join('') +
      `<li class="more-legs"><details><summary><span class="s-closed">Show all ${a.legs.length} games</span><span class="s-open">Hide games</span></summary><ul class="ticket-legs">${a.legs.slice(SHOW).map(legRow).join('')}</ul></details></li>`
    : a.legs.map(legRow).join('');
  return `<article class="ticket g-${a.grp}">
    <div class="ticket-head">
      <div><h3>${esc(a.name)}</h3><p><b class="games-pill">${a.legs.length} games</b> ${chance(a.probability)} chance</p></div>
      <span class="num ${a.total_odds >= 1000 ? 'num-xl' : ''}">${fmtOdds(a.total_odds)}</span>
    </div>
    <ul class="ticket-legs">${legs}</ul>
    ${codeBox(a)}
    <div class="ticket-foot">${resultBadge || '<span></span>'}
      ${open ? `<button class="add" data-acca="${a.id}">Add all to slip</button>` : ''}</div>
  </article>`;
}

// ---------- bookmaker picker ----------
const platformOf = key => state.platforms.find(p => p.key === key) || state.platforms[0];

function renderPlatforms() {
  const html = state.platforms.map(p =>
    `<button type="button" role="radio" aria-checked="${p.key === state.platform}" data-platform="${p.key}">${esc(p.name)}</button>`).join('');
  $$('[data-platform-group]').forEach(g => (g.innerHTML = html));
}

async function choosePlatform(key) {
  if (key === state.platform) return;
  state.platform = key; renderPlatforms();
  if (state.data) renderPicks();
  if (state.dash) renderDash();
  try { await api('/api/me/platform', { method: 'PUT', body: { platform: key } }); toast(`Showing ${platformOf(key).name} codes`); }
  catch (err) { toast(err.message); }
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-platform]');
  if (btn) choosePlatform(btn.dataset.platform);
});

// Booking code for a ticket on the user's bookmaker.
function codeBox(a) {
  const pf = platformOf(state.platform);
  const code = a.codes && a.codes[pf.key];
  const allStarted = a.legs.every(started);
  if (!code) {
    if (allStarted) return '';
    const others = state.platforms.filter(p => a.codes && a.codes[p.key]);
    return `<div class="code-box pending"><div><span>${esc(pf.name)} booking code</span><b>Coming soon</b></div>
      ${others.length ? `<p>Ready now on ${others.map(o => `<button class="link" data-platform="${o.key}">${esc(o.name)}</button>`).join(', ')}.</p>` : ''}</div>`;
  }
  return `<div class="code-box">
    <div><span>${esc(pf.name)} booking code</span><b class="code">${esc(code)}</b></div>
    <div class="code-actions">
      <button class="add" data-copy="${esc(code)}">Copy code</button>
      <a class="add solid" href="${esc(pf.url)}" target="_blank" rel="noopener">Open ${esc(pf.name)}</a>
    </div>
    <p>On ${esc(pf.name)}, open the betslip, enter the booking code and load it. Their odds may differ slightly from ours.</p>
  </div>`;
}

document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const code = btn.dataset.copy;
  try { await navigator.clipboard.writeText(code); toast(`Copied ${code}`); }
  catch { toast(`Your code is ${code}. Press and hold it to copy.`); }
});

// Slip buttons (event delegation works for picks, tickets and the slip view).
document.addEventListener('click', async e => {
  const add = e.target.closest('[data-add]'), rem = e.target.closest('[data-remove]'), acca = e.target.closest('[data-acca]');
  try {
    if (add) { await api('/api/slip', { method: 'POST', body: { predictionId: +add.dataset.add } }); toast('Added to slip'); }
    else if (rem) { await api('/api/slip/' + rem.dataset.remove, { method: 'DELETE' }); toast('Removed from slip'); }
    else if (acca) { const r = await api('/api/slip/acca/' + acca.dataset.acca, { method: 'POST' }); toast(`Added ${r.added} picks to slip`); }
    else return;
  } catch (err) { toast(err.message); return; }
  refreshSlipCount();
  if (state.view === 'slip') loadSlip(); else if (state.view === 'home') loadDash(); else loadDay(state.date);
});

// ---------- slip ----------
async function refreshSlipCount() {
  const { picks } = await api('/api/slip');
  const open = picks.filter(p => !started(p)).length;
  $('#slip-count').textContent = open; $('#slip-count').hidden = !open;
  return picks;
}

async function loadSlip() {
  const picks = await refreshSlipCount();
  const upcoming = picks.filter(p => !started(p));
  const total = upcoming.reduce((x, p) => x * p.odds, 1);
  $('#slip-odds').textContent = upcoming.length ? total.toFixed(2) : '—';
  $('#slip-list').innerHTML = picks.length ? picks.map(p => pickRow({ ...p, saved: true }, { showLeague: true })).join('')
    : empty('Your slip is empty.', 'Open Picks and tap "Add to slip" on the games you like.');
}

// ---------- record ----------
async function loadRecord() {
  const { tiers, accas, recent } = await api('/api/stats');
  const order = ['low', 'medium', 'high'], names = { low: 'Low odds', medium: 'Medium odds', high: 'High odds' };
  const cards = order.map(k => {
    const t = tiers.find(x => x.tier === k) || { won: 0, lost: 0, profit: 0 };
    const n = t.won + t.lost, rate = n ? Math.round((t.won / n) * 100) : 0;
    return `<div class="stat t-${k}"><h3>${names[k]}</h3><div class="big">${n ? rate + '%' : '—'}</div>
      <p>${t.won} won, ${t.lost} lost${t.avg_odds ? ` at avg odds ${t.avg_odds}` : ''}</p>
      <p>Profit: ${t.profit > 0 ? '+' : ''}${t.profit ?? 0} units</p></div>`;
  }).join('');
  const accaTable = accas.length ? `<table><tr><th>Long bet</th><th>Won</th><th>Lost</th></tr>${accas.map(a =>
    `<tr><td>${esc(a.name)}</td><td>${a.won}</td><td>${a.lost}</td></tr>`).join('')}</table>` : '<p class="muted">No settled long bets yet.</p>';
  const days = recent.length ? `<table><tr><th>Day</th><th>Won</th><th>Lost</th><th>Hit rate</th></tr>${recent.map(r =>
    `<tr><td>${new Date(r.date + 'T12:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</td>
    <td>${r.won}</td><td>${r.lost}</td><td>${Math.round((r.won / (r.won + r.lost)) * 100)}%</td></tr>`).join('')}</table>` : '<p class="muted">No settled picks yet.</p>';
  $('#record').innerHTML = cards + `<div class="record-wide"><h3>Long bets</h3>${accaTable}</div><div class="record-wide"><h3>By day</h3>${days}</div>`;
}

// ---------- home dashboard ----------
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

async function loadDash() {
  try { state.dash = await api('/api/dashboard'); } catch { return; }
  renderDash();
}

function renderDash() {
  const d = state.dash, root = $('[data-panel=home]');
  const hour = new Date().getHours();
  $('#d-hello').textContent = `${hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}`;
  $('#d-totals').innerHTML = `
    <div><b>${d.totals.games}</b><span>games ${d.isToday ? 'today' : 'tomorrow'}</span></div>
    <div><b>${d.totals.open}</b><span>picks open</span></div>
    <div><b>${d.tickets.length}</b><span>tickets</span></div>
    <div><b>${d.lowStreak}</b><span>low-odds win streak</span></div>`;
  renderPlatforms();

  // Pick of the day
  const p = d.pickOfDay;
  $('#d-potd').innerHTML = p ? `
    <div class="hud-head"><h2>Pick of the day</h2><span class="chip t-${p.tier}">${esc(p.tier)} odds</span></div>
    <div class="potd-body">
      ${ring(p.probability, pct(p.probability), 'chance')}
      <div>
        <p class="potd-match">${esc(p.home)} <span class="vs">v</span> ${esc(p.away)}</p>
        <p class="muted-inline">${esc(p.league_name)}, ${time(p.kickoff)}</p>
        <p class="potd-pick">${esc(p.market)}<b>${esc(p.pick)}</b></p>
      </div>
    </div>
    <div class="potd-foot"><span class="potd-odds">${p.odds.toFixed(2)}</span>${addButton(p)}</div>`
    : `<div class="hud-head"><h2>Pick of the day</h2></div><p class="muted">The next pick of the day appears with tomorrow's predictions.</p>`;

  // Odds-band gauges
  $('#d-gauges').innerHTML = d.tiers.map(t => `
    <button class="hud gauge t-${t.key}" data-goto="${t.key}" aria-label="Open ${esc(t.label)} picks">
      ${ring(t.hitRate, pct(t.hitRate), 'hit rate, 30 days', 'var(--c)')}
      <div class="gauge-info">
        <h3>${esc(t.label)}</h3>
        <p class="gauge-range">${t.min.toFixed(2)}${t.max < 8 ? '–' + t.max.toFixed(2) : '+'}</p>
        <dl><div><dt>Picks</dt><dd>${t.count}</dd></div><div><dt>Top odds</dt><dd>${t.bestOdds ? t.bestOdds.toFixed(2) : '—'}</dd></div>
        <div><dt>Record</dt><dd>${t.won}–${t.lost}</dd></div></dl>
      </div>
    </button>`).join('');

  // Ticket strip with the code for the user's bookmaker
  const pf = platformOf(state.platform);
  $('#d-tickets').innerHTML = d.tickets.length ? d.tickets.map(t => {
    const code = t.codes[pf.key];
    const state_ = t.result !== 'pending' ? `<span class="badge ${t.result}">${t.result === 'won' ? 'Won' : t.result === 'lost' ? 'Lost' : 'Void'}</span>`
      : t.started ? `<span class="badge live">${t.won} of ${t.legs} won so far</span>` : `<span class="muted-inline">Starts ${time(t.firstKickoff)}</span>`;
    return `<article class="strip-card g-${t.grp}">
      <p class="strip-name">${esc(t.name)}</p>
      <p class="strip-odds">${fmtOdds(t.total_odds)}</p>
      <p class="muted-inline">${t.legs} games, ${chance(t.probability)} chance</p>
      ${code ? `<button class="strip-code" data-copy="${esc(code)}" aria-label="Copy ${esc(pf.name)} code ${esc(code)}"><small>${esc(pf.name)}</small>${esc(code)}</button>`
             : `<p class="strip-code empty-code"><small>${esc(pf.name)}</small>Code coming soon</p>`}
      ${state_}
    </article>`; }).join('') : '<p class="muted">Tickets are built every morning.</p>';

  // Live and results
  $('#d-live').innerHTML = d.live.length ? `<ul class="live-list">${d.live.map(g => {
    const done = ['FT', 'AET', 'PEN'].includes(g.status);
    const verdict = g.won || g.lost ? `<span class="tally"><b class="w">${g.won}</b>/<b class="l">${g.lost}</b></span>` : '';
    return `<li class="${done ? '' : 'is-live'}">
      <span class="live-status">${done ? 'FT' : '<i></i>Live'}</span>
      <span class="live-teams">${esc(g.home)}<br>${esc(g.away)}</span>
      <span class="live-score">${g.home_goals ?? '–'}<br>${g.away_goals ?? '–'}</span>
      ${verdict ? `<span class="live-picks" title="Our picks won / lost">${verdict}</span>` : '<span class="live-picks muted-inline">In play</span>'}
    </li>`; }).join('')}</ul>` : `<p class="muted">No games have kicked off yet ${d.isToday ? 'today' : ''}. Scores appear here once they start.</p>`;

  // Form: daily hit rate bars + last 20 picks
  const maxH = 64;
  $('#d-form').innerHTML = `
    <div class="bars" role="img" aria-label="Daily hit rate for the last ${d.days.length} days">
      ${d.days.map(x => { const r = x.won / (x.won + x.lost);
        return `<div class="bar" title="${x.date}: ${Math.round(r * 100)}%"><span style="height:${Math.max(4, r * maxH)}px" class="${r >= .5 ? 'up' : 'down'}"></span>
          <small>${new Date(x.date + 'T12:00').toLocaleDateString([], { weekday: 'narrow' })}</small></div>`; }).join('')}
    </div>
    <div class="form-stats">${(() => {
      const w = d.days.reduce((a, x) => a + x.won, 0), l = d.days.reduce((a, x) => a + x.lost, 0);
      const best = d.days.reduce((b, x) => (!b || x.won / (x.won + x.lost) > b.won / (b.won + b.lost) ? x : b), null);
      const up = d.days.filter(x => x.won >= x.lost).length;
      return `<div><span>Record</span><b>${w}–${l}</b></div>
        <div><span>Hit rate</span><b>${w + l ? Math.round(w / (w + l) * 100) + '%' : '—'}</b></div>
        <div><span>Winning days</span><b>${up}/${d.days.length}</b></div>
        <div><span>Best day</span><b>${best ? Math.round(best.won / (best.won + best.lost) * 100) + '%' : '—'}</b></div>`; })()}</div>
    <p class="form-label">Last ${d.form.length} picks, newest first</p>
    <div class="dots">${d.form.map(f => `<span class="${f.result === 'won' ? 'w' : 'l'}" title="${esc(f.home)} v ${esc(f.away)}: ${f.result}"></span>`).join('')}</div>`;

  // Slip return calculator
  const s = d.slip;
  $('#d-slip').innerHTML = `
    <div class="hud-head"><h2>My slip</h2><button class="link" data-goto="slip">Open slip</button></div>
    <div class="calc">
      <div><span>Open picks</span><b>${s.count}</b></div>
      <div><span>Total odds</span><b>${s.count ? s.totalOdds.toFixed(2) : '—'}</b></div>
      <label><span>Stake (GH₵)</span><input id="d-stake" type="number" min="1" step="1" value="10" inputmode="decimal"></label>
      <div class="calc-out"><span>Could return</span><b id="d-return">—</b></div>
    </div>
    ${s.count ? '' : '<p class="muted calc-hint">Add picks to your slip to see what they could return.</p>'}`;
  const upd = () => {
    const stake = parseFloat($('#d-stake').value) || 0;
    $('#d-return').textContent = s.count ? 'GH₵ ' + (stake * s.totalOdds).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
  };
  $('#d-stake').addEventListener('input', upd); upd();

  sweepRings(root);
  tickCountdown();
}

// Countdown to the next kickoff, ticking every second.
function tickCountdown() {
  const d = state.dash; if (!d) return;
  const set = (u, v) => ($(`#d-countdown [data-u=${u}]`).textContent = String(v).padStart(2, '0'));
  if (!d.next) {
    $('#d-next-label').textContent = 'No upcoming games yet';
    ['h', 'm', 's'].forEach(u => set(u, 0)); $('#d-next-match').textContent = 'New predictions are published every morning.';
    return;
  }
  let ms = Math.max(0, new Date(d.next.kickoff) - Date.now());
  if (ms === 0) { loadDash(); return; }
  const h = Math.floor(ms / 3.6e6); ms -= h * 3.6e6;
  const m = Math.floor(ms / 6e4); ms -= m * 6e4;
  set('h', h); set('m', m); set('s', Math.floor(ms / 1000));
  $('#d-next-label').textContent = 'Next kickoff in';
  $('#d-next-match').innerHTML = `${esc(d.next.home)} <span class="vs">v</span> ${esc(d.next.away)} <span class="muted-inline">${esc(d.next.league_name)}, ${time(d.next.kickoff)}</span>`;
}
setInterval(() => { if (state.view === 'home' && !document.hidden) tickCountdown(); }, 1000);
// Refresh live scores every 2 minutes while the dashboard is open.
setInterval(() => { if (state.view === 'home' && !document.hidden) loadDash(); }, 120000);

document.addEventListener('click', e => {
  const g = e.target.closest('[data-goto]');
  if (!g) return;
  if (g.dataset.goto === 'slip') return showView('slip');
  state.tier = g.dataset.goto;
  showView('picks');
});

// ---------- boot ----------
api('/api/me').then(startApp).catch(() => showAuth());
