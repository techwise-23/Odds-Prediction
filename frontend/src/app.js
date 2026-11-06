// OddsDay public app — plain JavaScript, no build step.
// Talks to the API at ODDSDAY_CONFIG.apiUrl (see config.js).
const API_URL = ((window.ODDSDAY_CONFIG && window.ODDSDAY_CONFIG.apiUrl) || '').replace(/\/$/, '');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { user: null, posts: [], platforms: [], open: null, premium: { active: false, until: null, enabled: false, plans: [], currency: 'GHS' } };

// Session token kept in this browser as a fallback for browsers that block cross-site cookies (see the backend's auth.js).
const TOKEN_KEY = 'oddsday_token';
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
const setToken = t => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } };

async function api(path, opts = {}) {
  // Standalone phone app: the backend runs inside the page.
  if (window.LocalAPI) {
    const r = await window.LocalAPI.request(opts.method || 'GET', path, opts.body);
    if (r.status === 401 && path !== '/api/login') { showAuth(); throw new Error('Please log in'); }
    if (r.status >= 400) throw new Error(r.data.error || 'Something went wrong. Try again.');
    return r.data;
  }
  let res;
  try { res = await fetch(API_URL + path, {
    method: opts.method || 'GET',
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(getToken() ? { Authorization: 'Bearer ' + getToken() } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'include',
  }); }
  catch { throw new Error(API_URL ? `Can't reach the server at ${API_URL}. Check that the backend is running, API_URL is its public https address, and CORS_ORIGINS on the backend lists this site.` : "Can't reach the server. API_URL is not set for this site."); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { setToken(''); showAuth(); throw new Error('Please log in'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  if (path === '/api/login' || path === '/api/register') setToken(data.token);
  if (path === '/api/logout') setToken('');
  return data;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2400);
}


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

function showAuth() { $('#app-view').hidden = true; $('#auth-view').hidden = false; document.body.classList.remove('in-app'); }

// ---------- shell ----------
async function startApp() {
  const me = await api('/api/me');
  state.user = me.user;
  $('#auth-view').hidden = true; $('#app-view').hidden = false; document.body.classList.add('in-app');
  $('#avatar').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M4.5 20c.8-4 3.7-6 7.5-6s6.7 2 7.5 6"/></svg>';
  $('#menu-name').textContent = state.user.name;
  state.telegram = !!me.telegram;
  $('#tg-open').hidden = !me.telegram;
  await loadPosts();
  checkReturn();
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
    body.innerHTML = `<p class="muted">Get a message on Telegram when a new booking code is posted for your bookmaker.</p>
      ${linkUrl ? `<a class="btn-primary tg-link" href="${esc(linkUrl)}" target="_blank" rel="noopener">Open Telegram and tap Start</a>
        <p class="fineprint">Waiting for you to tap Start in Telegram…</p>`
        : '<button class="btn-primary" id="tg-connect" type="button">Connect Telegram</button>'}`;
    const c = $('#tg-connect');
    if (c) c.addEventListener('click', tgConnect);
    return;
  }
  body.innerHTML = `<p class="tg-on">✅ Telegram is connected.</p>
    <label class="tg-opt"><input type="checkbox" data-tg="notifyCodes" ${t.notifyCodes ? 'checked' : ''}> New booking code posted</label>
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


// ---------- booking codes ----------
const fmtWhen = iso => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const platformOf = key => state.platforms.find(p => p.key === key) || { key, name: key, url: '' };

async function loadPosts() {
  let r;
  try { r = await api('/api/posts'); } catch (err) { $('#posts').innerHTML = `<div class="empty"><b>Could not load codes.</b><br>${esc(err.message)}</div>`; return; }
  state.posts = r.posts; state.platforms = r.platforms; state.premium = r.premium || state.premium;
  renderPosts();
  if (state.open) { const p = state.posts.find(x => x.id === state.open); p ? openPost(p.id) : closeDialog(); }
}

const ICON = {
  vip: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M7 36l-2-20 12 10 7-14 7 14 12-10-2 20z"/><path d="M9 42h30"/></svg>',
  lock: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="10" y="21" width="28" height="21" rx="4"/><path d="M16 21v-6a8 8 0 0 1 16 0v6M24 29v6"/></svg>',
  daily: '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="8.5"/><path d="M24 5v6M24 37v6M5 24h6M37 24h6M10.6 10.6l4.2 4.2M33.2 33.2l4.2 4.2M37.4 10.6l-4.2 4.2M14.8 33.2l-4.2 4.2"/></svg>',
  long: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M15 8h18v10a9 9 0 0 1-18 0V8z"/><path d="M15 12H8c0 6 3 9 7 9M33 12h7c0 6-3 9-7 9M24 27v8M17 41h14M19 35h10"/></svg>',
};

// Hero art drawn in SVG: floodlit stadium, striped pitch and a gold football. (No photos, so nothing to license.)
const STADIUM = `<svg viewBox="0 0 420 340" preserveAspectRatio="xMidYMin slice" aria-hidden="true">
  <defs>
    <linearGradient id="sk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#030A22"/><stop offset=".55" stop-color="#0A2060"/><stop offset="1" stop-color="#0B2C7A"/></linearGradient>
    <linearGradient id="pt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1C7A2E"/><stop offset="1" stop-color="#0A3D17"/></linearGradient>
    <radialGradient id="bl" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#FFE27A"/><stop offset=".55" stop-color="#F5B400"/><stop offset="1" stop-color="#9A6400"/></radialGradient>
    <radialGradient id="gl"><stop offset="0" stop-color="#FFD24A" stop-opacity=".55"/><stop offset="1" stop-color="#FFD24A" stop-opacity="0"/></radialGradient>
    <filter id="bz"><feGaussianBlur stdDeviation="2.2"/></filter>
    <pattern id="cr" width="9" height="7" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="#6EA2FF" opacity=".35"/><circle cx="6.5" cy="5" r=".9" fill="#FFD24A" opacity=".22"/></pattern>
  </defs>
  <rect width="420" height="340" fill="url(#sk)"/>
  <path d="M0 112C90 84 330 84 420 112V196H0z" fill="#07163F"/><path d="M0 112C90 84 330 84 420 112V196H0z" fill="url(#cr)"/>
  <path d="M0 112C90 84 330 84 420 112" fill="none" stroke="#7FB0FF" stroke-opacity=".4" stroke-width="1.5"/>
  <g filter="url(#bz)" fill="#fff">${Array.from({ length: 22 }, (_, i) => { const x = 14 + i * 18.6, y = 70 + Math.abs(i - 10.5) * 1.5; return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.1"/><circle cx="${x.toFixed(1)}" cy="${(y + 9).toFixed(1)}" r="2.4"/>`; }).join('')}</g>
  <path d="M0 196h420v144H0z" fill="url(#pt)"/>
  ${Array.from({ length: 7 }, (_, i) => `<path d="M${-60 + i * 80} 196h40l${(i - 3) * 22 + 40} 144h-60z" fill="#fff" opacity=".05"/>`).join('')}
  <ellipse cx="210" cy="262" rx="150" ry="30" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="2"/><path d="M0 262h420" stroke="#fff" stroke-opacity=".25" stroke-width="2"/>
  <circle cx="372" cy="214" r="110" fill="url(#gl)"/>
  <g transform="translate(374 214) scale(.85)"><circle r="64" fill="url(#bl)"/>
    <path d="M0-22l21 15-8 25H-13l-8-25z" fill="#2A1A00" opacity=".85"/>
    <path d="M0-22V-64M21-7l40-13M13 18l24 34M-13 18l-24 34M-21-7l-40-13" stroke="#2A1A00" stroke-width="3" opacity=".6"/>
    <path d="M-44-46l10 12-12 8-8-14zM44-46l-10 12 12 8 8-14zM0 64l-14-8 4-14h20l4 14z" fill="#2A1A00" opacity=".7"/></g>
</svg>`;
const BALL = `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="lb" cx=".35" cy=".3" r=".85"><stop offset="0" stop-color="#FFE27A"/><stop offset=".6" stop-color="#F5B400"/><stop offset="1" stop-color="#9A6400"/></radialGradient></defs>
  <circle cx="32" cy="32" r="29" fill="url(#lb)" stroke="#2A1A00" stroke-width="2.5"/><path d="M32 21l9 6.5-3.5 10.5h-11L23 27.5z" fill="#2A1A00"/>
  <path d="M32 21V4M41 27.5l16-5M37.5 38l10 14M26.5 38l-10 14M23 27.5l-16-5" stroke="#2A1A00" stroke-width="2.4" fill="none"/></svg>`;
const SI = {
  clip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6v3H9zM7 5.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5V7A1.5 1.5 0 0 0 18 5.5h-1"/><path d="M8.5 12h7M8.5 16h4"/></svg>',
  cup: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M15 8h18v10a9 9 0 0 1-18 0V8z"/><path d="M15 12H8c0 6 3 9 7 9M33 12h7c0 6-3 9-7 9M24 27v8M17 41h14M19 35h10"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.4 2"/></svg>',
  bars: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V12M12 20V5M19 20V9"/></svg>',
  hand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11V5a1.6 1.6 0 0 1 3.2 0v5l4.3.8a2 2 0 0 1 1.6 2.3l-.9 5.2a2 2 0 0 1-2 1.7H10a2 2 0 0 1-1.6-.8L5 14.6a1.5 1.5 0 0 1 2.3-1.9L9 14z"/></svg>',
  mark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v18l-5-4-5 4z"/></svg>',
  tick: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12.5l3 3 5-6"/></svg>',
};
// SVG gradients are looked up by id across the whole page, and one copy sits in a hidden view, so every copy gets its own ids.
let uid = 0;
const uniq = svg => { const p = 'u' + (++uid) + '-'; return svg.replace(/id="([\w-]+)"/g, `id="${p}$1"`).replace(/url\(#([\w-]+)\)/g, `url(#${p}$1)`); };
$$('.stadium-slot').forEach(el => { el.innerHTML = uniq(STADIUM); });
$$('.ball-logo').forEach(el => { el.innerHTML = uniq(BALL); });

const initials = n => n.replace(/[^A-Za-z0-9 .]/g, '').split(/[ .]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();

// "Closes in 5h 12m"
function remaining(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return 'Closing now';
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  if (d) return `${d}d ${h}h left`;
  if (h) return `${h}h ${m % 60}m left`;
  return `${Math.max(1, m)}m left`;
}
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

function postCard(p, i) {
  const long = p.kind === 'long', vip = p.premium, locked = p.locked;
  const books = state.platforms.filter(b => p.books.includes(b.key));
  const created = new Date(p.createdAt.replace(' ', 'T') + (/[zZ]$/.test(p.createdAt) ? '' : 'Z')).getTime();
  const span = long ? Math.max(1, new Date(p.lastMatchAt) - created) : 0;
  const pct = long ? Math.min(100, Math.max(4, ((Date.now() - created) / span) * 100)) : 0;
  const label = vip ? 'Premium' : long ? 'Long bet' : 'Today';
  return `<button type="button" class="ticket ${long ? 'is-long' : ''} ${vip ? 'is-vip' : ''} ${locked ? 'is-locked' : ''}" ${locked ? 'data-unlock' : `data-post="${p.id}"`} style="--i:${i}">
    <span class="stub">${ICON[locked ? 'lock' : vip ? 'vip' : p.kind]}<small>${label}</small></span>
    <span class="body">
      <b class="t-title">${esc(p.title || (vip ? 'Premium slip' : long ? 'Long bet slip' : "Today's slip"))}</b>
      <span class="chips" aria-label="Available on">${books.map(b => `<i class="chip" title="${esc(b.name)}">${esc(initials(b.name))}</i>`).join('')}
        <em>${books.length} bookmaker${books.length === 1 ? '' : 's'}</em></span>
      ${long ? `<span class="track" role="img" aria-label="Time until the last match"><i style="width:${pct.toFixed(0)}%"></i></span>
        <span class="t-meta">Last match ${esc(fmtWhen(p.lastMatchAt))}</span>`
        : `<span class="t-meta"><span class="live-dot"></span><span data-expires="${esc(p.expiresAt)}">${esc(remaining(p.expiresAt))}</span></span>`}
    </span>
    <span class="get">${locked ? 'Unlock' : 'Get code'}<i aria-hidden="true">›</i></span>
  </button>`;
}

function ghostTicket(kind) {
  const long = kind === 'long', vip = kind === 'vip';
  return `<div class="ticket ghost">
    <span class="stub">${ICON[kind]}<small>${vip ? 'Premium' : long ? 'Long bet' : 'Today'}</small></span>
    <span class="body"><b class="t-title">${long ? 'No long bet open' : vip ? 'No premium slip yet' : 'Not posted yet'}</b>
      <span class="t-meta">${vip ? 'Premium slips with higher odds show here when they are posted.' : long ? 'A long bet shows here when one is posted, and stays until its last match.' : 'Today\'s code shows here as soon as it\'s posted. Turn on Telegram alerts in the menu to get pinged.'}</span></span>
  </div>`;
}

function renderPosts() {
  const daily = state.posts.filter(p => p.kind === 'daily' && !p.premium), long = state.posts.filter(p => p.kind === 'long' && !p.premium), vip = state.posts.filter(p => p.premium);
  const next = state.posts.filter(p => !p.locked).map(p => p.kind === 'long' ? null : p.expiresAt).filter(Boolean).sort()[0];
  const live = state.posts.length;
  let i = 0;
  const first = !renderPosts.done; renderPosts.done = true;
  $('#posts').className = first ? 'enter' : '';
  const today = new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  $('#posts').innerHTML = `
    <section class="hero">
      <div class="stadium">${uniq(STADIUM)}</div>
      <div class="hero-copy">
        <p class="hello">${greeting()},${state.premium.active ? `<span class="vip-badge">${ICON.vip}Premium until ${esc(new Date(state.premium.until).toLocaleDateString([], { day: 'numeric', month: 'short' }))}</span>` : ''}</p>
        <h1>${live ? `${live} live slip${live === 1 ? '' : 's'}<br><em>ready</em> to load` : 'Your next slip<br><em>lands</em> here'}</h1>
        <p class="hero-sub">${live ? "Don't miss today's winning opportunities!" : "We'll show the next booking code here as soon as it's posted."}</p>
        ${live ? '<button type="button" class="hero-cta" data-scroll="slips">View Slips <i aria-hidden="true">→</i></button>' : ''}
      </div>
    </section>
    <div class="board" role="group" aria-label="Today at a glance">
      <div><span class="bi blue">${SI.clip}</span><b>${live}</b><span>Live slips</span></div>
      <div><span class="bi gold">${SI.cup}</span><b>${state.platforms.length}</b><span>Bookmakers</span></div>
      <div><span class="bi blue">${SI.clock}</span><b class="clock" ${next ? `data-expires="${esc(next)}" data-short` : ''}>${next ? shortLeft(next) : '—'}</b><span>${next ? "Until today's code closes" : 'Waiting for a code'}</span></div>
    </div>
    <div id="slips"></div>
    <h2 class="rail"><span>Today's Booking Code</span><time>${esc(today)}</time></h2>
    <div class="tickets">${daily.length ? daily.map(p => postCard(p, i++)).join('') : ghostTicket('daily')}</div>
    ${vip.length || state.premium.plans.length ? `<h2 class="rail rail-vip"><span>${ICON.vip}Premium Odds</span></h2>
      <div class="tickets">${vip.length ? vip.map(p => postCard(p, i++)).join('') : ghostTicket('vip')}</div>` : ''}
    <h2 class="rail"><span><i class="rail-ico">${SI.bars}</i>Long Bet Booking Code</span></h2>
    <div class="tickets">${long.length ? long.map(p => postCard(p, i++)).join('') : ghostTicket('long')}</div>
    ${vipBanner()}
    <section class="how" aria-labelledby="how-h">
      <h2 id="how-h">Load a Code <span>in Three Simple Steps</span></h2>
      <ol>
        <li><i class="step-n">1</i>${SI.hand}<b>Tap a slip</b><span>Today's code or a long bet.</span></li>
        <li><i class="step-n">2</i>${SI.mark}<b>Pick your bookmaker</b><span>You only see codes for the company you bet with.</span></li>
        <li><i class="step-n">3</i>${SI.tick}<b>Paste it on the betslip</b><span>Copy the code, open your app, and load it.</span></li>
      </ol>
    </section>`;
  updateBell();
}

// Bell: counts live slips you haven't opened since the last time you tapped it.
const seenIds = () => { try { return JSON.parse(localStorage.getItem('oddsday_seen') || '[]'); } catch { return []; } };
function updateBell() {
  const seen = seenIds(), n = state.posts.filter(p => !p.locked && !seen.includes(p.id)).length, b = $('#bell-n');
  b.hidden = !n; b.textContent = n > 9 ? '9+' : n;
}
$('#bell').addEventListener('click', () => {
  const n = state.posts.filter(p => !p.locked && !seenIds().includes(p.id)).length;
  try { localStorage.setItem('oddsday_seen', JSON.stringify(state.posts.map(p => p.id))); } catch { /* storage blocked */ }
  updateBell();
  toast(n ? `${n} new code${n === 1 ? '' : 's'} below` : 'No new codes right now');
  $('#slips').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Bottom tab bar.
document.querySelector('.dock').addEventListener('click', e => {
  const b = e.target.closest('[data-dock]'); if (!b) return;
  e.stopPropagation(); // the page closes the menu on any outside click
  const to = b.dataset.dock;
  $$('.dock button').forEach(x => x.classList.toggle('on', x === b && to !== 'account' && to !== 'alerts'));
  if (to === 'account' || to === 'alerts') document.querySelector('.dock [data-dock="home"]').classList.add('on');
  if (to === 'home') window.scrollTo({ top: 0, behavior: 'smooth' });
  if (to === 'premium') openPremium();
  if (to === 'alerts') { if (state.telegram) $('#tg-open').click(); else toast('Telegram alerts are not set up yet.'); }
  if (to === 'account') $('#menu-btn').click();
});
document.addEventListener('click', e => { const s = e.target.closest('[data-scroll]'); if (s) $('#slips').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
function shortLeft(iso) { const ms = new Date(iso) - Date.now(); if (ms <= 0) return '0m'; const m = Math.floor(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; }
// Keep the countdowns ticking.
setInterval(() => $$('[data-expires]').forEach(el => { el.textContent = el.hasAttribute('data-short') ? shortLeft(el.dataset.expires) : remaining(el.dataset.expires); }), 20000);


// ---------- premium ----------
const CUR = { GHS: 'GH₵', NGN: '₦', ZAR: 'R', KES: 'KSh', USD: '$' };
const money = n => (CUR[state.premium.currency] || state.premium.currency + ' ') + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

function vipBanner() {
  const pr = state.premium;
  if (pr.active) {
    const days = Math.max(1, Math.ceil((new Date(pr.until) - Date.now()) / 86400000));
    return `<section class="vip-banner is-active"><div><b>You're a Premium member</b><span>${days} day${days === 1 ? '' : 's'} left. Premium slips are unlocked.</span></div>
      ${pr.enabled ? '<button type="button" class="get" data-unlock>Add time</button>' : ''}</section>`;
  }
  const low = pr.plans.length ? pr.plans.reduce((m, p) => Math.min(m, p.price), Infinity) : 0;
  return `<section class="vip-banner"><div class="vip-copy"><span class="vip-crown">${ICON.vip}</span>
      <b>Go Premium</b><span>Unlock higher-odds slips and long bets that free members don't see.${pr.enabled && low ? ` From ${esc(money(low))}.` : ''}</span></div>
    ${pr.enabled ? '<button type="button" class="get" data-unlock>See plans</button>' : '<span class="soon">Coming soon</span>'}</section>`;
}

const premiumDialog = $('#premium-dialog');
const premState = { plan: null };
function openPremium() {
  const pr = state.premium;
  if (!pr.enabled) { toast('Premium is not open yet. Check back soon.'); return; }
  if (!premState.plan || !pr.plans.some(p => p.key === premState.plan)) premState.plan = (pr.plans.find(p => p.best) || pr.plans[0]).key;
  $('#premium-body').innerHTML = `
    <p class="muted">${pr.active ? 'Add more time to your Premium membership.' : 'Pay once for the time you want. No auto-renewal.'}</p>
    <div class="plan-list" role="radiogroup" aria-label="Plan">${pr.plans.map(p => `<button type="button" class="plan" role="radio" aria-checked="${p.key === premState.plan}" data-plan="${esc(p.key)}">
        <span><b>${esc(p.name)}</b><small>${p.days} day${p.days === 1 ? '' : 's'}</small></span><span class="price">${esc(money(p.price))}</span>${p.best ? '<em>Best value</em>' : ''}</button>`).join('')}</div>
    <label class="fld">Email for your receipt <small>(optional)</small><input id="pay-email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com"></label>
    <ul class="vip-perks"><li>Premium slips with bigger odds</li><li>Long bets with codes for your bookmaker</li><li>Instant access after payment</li></ul>
    <button type="button" class="btn-primary" id="pay-go">Pay with Paystack</button>
    <p class="fineprint">You'll pay on Paystack's secure page with mobile money or card. We never see your card or MoMo PIN.</p>`;
  if (!premiumDialog.open) premiumDialog.showModal();
}
async function startPayment() {
  const btn = $('#pay-go'); btn.disabled = true; btn.textContent = 'Opening Paystack…';
  try {
    const r = await api('/api/premium/checkout', { method: 'POST', body: { plan: premState.plan, email: $('#pay-email').value.trim(), returnUrl: location.origin + '/' } });
    try { sessionStorage.setItem('oddsday_pay', r.reference); } catch { /* fine */ }
    location.href = r.url;
  } catch (err) { btn.disabled = false; btn.textContent = 'Pay with Paystack'; toast(err.message, 5000); }
}
premiumDialog.addEventListener('click', e => {
  const plan = e.target.closest('[data-plan]');
  if (plan) { premState.plan = plan.dataset.plan; $$('[data-plan]', premiumDialog).forEach(b => b.setAttribute('aria-checked', b === plan)); }
  if (e.target.closest('#pay-go')) startPayment();
  if (e.target === premiumDialog || e.target.closest('.premium-close')) premiumDialog.close();
});

// Back from Paystack: confirm the payment with the server, which asks Paystack itself.
async function checkReturn() {
  const q = new URLSearchParams(location.search);
  let ref = q.get('reference') || q.get('trxref');
  if (!ref) return;
  history.replaceState(null, '', location.pathname);
  try {
    toast('Confirming your payment…', 8000);
    const r = await api('/api/premium/verify', { method: 'POST', body: { reference: ref } });
    await loadPosts();
    toast(r.paid ? 'Payment received. Premium is on.' : 'Payment not completed. You were not charged.', 5000);
  } catch (err) { toast(err.message, 7000); }
}

// Tap a post: choose a bookmaker, then see that bookmaker's code.
const postDialog = $('#post-dialog');
function closeDialog() { state.open = null; if (postDialog.open) postDialog.close(); }

function openPost(id, platform) {
  const p = state.posts.find(x => x.id === id); if (!p) return;
  if (p.locked) return openPremium();
  state.open = id;
  const avail = state.platforms.filter(b => p.entries[b.key]);
  $('#post-title').textContent = (p.kind === 'long' ? 'Long bet' : "Today's") + (p.title ? ' · ' + p.title : '');
  const body = $('#post-body');
  if (!platform) {
    body.innerHTML = `<p class="muted">Which betting company do you use?</p>
      <div class="book-list">${state.platforms.map(b => p.entries[b.key]
        ? `<button type="button" class="book" data-book="${esc(b.key)}"><span>${esc(b.name)}</span><i aria-hidden="true">›</i></button>`
        : `<button type="button" class="book off" disabled><span>${esc(b.name)}</span><small>No code yet</small></button>`).join('')}</div>`;
  } else {
    const b = platformOf(platform), e = p.entries[platform];
    if (!e) { openPost(id); return; }
    body.innerHTML = `<button type="button" class="link back" data-back>‹ Other bookmakers</button>
      <h3 class="book-name">${esc(b.name)}</h3>
      ${e.code ? `<div class="code-box"><div><span>Booking code</span><b class="code">${esc(e.code)}</b></div>
        <div class="code-actions"><button class="add solid" data-copy="${esc(e.code)}">Copy code</button></div></div>` : ''}
      ${e.imageId ? `<figure class="slip-img"><img alt="${esc(b.name)} betslip" data-img="${esc(e.imageId)}"><figcaption>${e.code ? esc(e.code) : ''}</figcaption></figure>` : ''}
      ${e.link ? `<a class="btn-primary slip-link" href="${esc(e.link)}" target="_blank" rel="noopener noreferrer">Open the slip on ${esc(b.name)}</a>` : ''}
      ${b.url ? `<a class="add" href="${esc(b.url)}" target="_blank" rel="noopener">Open ${esc(b.name)}</a>` : ''}
      <p class="fineprint">On ${esc(b.name)}, open the betslip, enter the booking code and load it. Odds may differ slightly. 18+ only. Bet responsibly.</p>`;
    const img = $('img[data-img]', body);
    if (img) loadImage(img);
  }
  if (!postDialog.open) postDialog.showModal();
}

// Images need the login token, so fetch them and show them from memory.
async function loadImage(img) {
  try {
    const res = await fetch(API_URL + '/api/post-images/' + img.dataset.img, { credentials: 'include', headers: getToken() ? { Authorization: 'Bearer ' + getToken() } : {} });
    if (!res.ok) throw new Error();
    img.src = URL.createObjectURL(await res.blob());
  } catch { img.replaceWith(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Could not load the image.' })); }
}

document.addEventListener('click', async e => {
  if (e.target.closest('[data-unlock]')) return openPremium();
  const post = e.target.closest('[data-post]'), book = e.target.closest('[data-book]'), back = e.target.closest('[data-back]'), copy = e.target.closest('[data-copy]');
  if (post) return openPost(Number(post.dataset.post));
  if (book) return openPost(state.open, book.dataset.book);
  if (back) return openPost(state.open);
  if (copy) {
    const code = copy.dataset.copy;
    try { await navigator.clipboard.writeText(code); toast(`Copied ${code}`); }
    catch { toast(`Your code is ${code}. Press and hold it to copy.`); }
  }
});
postDialog.addEventListener('close', () => { state.open = null; });
$('.post-close', postDialog).addEventListener('click', closeDialog);
postDialog.addEventListener('click', e => { if (e.target === postDialog) closeDialog(); });

// Pick up new and expired posts without a reload.
setInterval(() => { if (!document.hidden && state.user) loadPosts(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.user) loadPosts(); });

// ---------- boot ----------
api('/api/me').then(startApp).catch(() => showAuth());
