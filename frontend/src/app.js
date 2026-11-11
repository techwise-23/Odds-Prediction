// PawaOdds public app — plain JavaScript, no build step.
// Talks to the API at ODDSDAY_CONFIG.apiUrl (see config.js).
const API_URL = ((window.ODDSDAY_CONFIG && window.ODDSDAY_CONFIG.apiUrl) || '').replace(/\/$/, '');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { user: null, posts: [], platforms: [], open: null, results: null, refer: null, premium: { active: false, until: null, enabled: false, plans: [], currency: 'GHS' } };

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
  if (res.status === 403 && data.blocked) { setToken(''); showAuth(); $('.form-error').textContent = data.error; throw new Error(data.error); }
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
  $('#ref-field').hidden = !reg;
  $('#auth-alt-text').textContent = reg ? 'Already have an account?' : 'New to PawaOdds?';
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
    if (authMode === 'register') body.ref = String(f.get('ref') || '').trim();
    const { user } = await api(authMode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body });
    try { localStorage.removeItem('pawa_ref'); } catch { /* fine */ }
    state.user = user; await startApp();
  } catch (err) { $('.form-error').textContent = err.message; }
  btn.disabled = false;
});

// A link like https://pawaodds.com/?ref=KOFI fills in the referral box (and is remembered until signup).
(function pickUpReferral() {
  let ref = '';
  try { ref = new URLSearchParams(location.search).get('ref') || ''; } catch { /* old browser */ }
  ref = ref.trim().slice(0, 20);
  try { if (ref) localStorage.setItem('pawa_ref', ref); else ref = localStorage.getItem('pawa_ref') || ''; } catch { /* storage blocked */ }
  if (ref) $('#auth-form [name=ref]').value = ref;
})();

function showAuth() { $('#app-view').hidden = true; $('#auth-view').hidden = false; document.body.classList.remove('in-app'); }

// ---------- shell ----------
async function startApp() {
  const me = await api('/api/me');
  state.user = me.user;
  $('#auth-view').hidden = true; $('#app-view').hidden = false; document.body.classList.add('in-app');
  $('#avatar').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M4.5 20c.8-4 3.7-6 7.5-6s6.7 2 7.5 6"/></svg>';
  $('#menu-name').textContent = state.user.name;
  state.telegram = !!me.telegram; 
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
  const body = $('#tg-box');
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
  $('#tg-box').innerHTML = '';
  if (state.telegram) { try { tgRender(await api('/api/me/telegram')); } catch (err) { return toast(err.message); } }
  renderPush();
  tgDialog.showModal();
});

// ---------- phone alerts (web push) and installing the app ----------
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isStandalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const keyBytes = b64 => { const p = '='.repeat((4 - b64.length % 4) % 4), raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* alerts and install just stay unavailable */ });

async function renderPush() {
  const box = $('#push-box');
  if (!pushSupported()) {
    box.innerHTML = `<h3 class="al-h">Phone alerts</h3><p class="muted">${isIOS && !isStandalone()
      ? 'On iPhone, first add PawaOdds to your home screen: tap the Share button, then <b>Add to Home Screen</b>, and open it from there.' : 'This browser cannot show phone alerts.'}</p>`;
    return;
  }
  let sub = null;
  try { sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription(); } catch { /* treated as off */ }
  const denied = Notification.permission === 'denied';
  box.innerHTML = `<h3 class="al-h">Phone alerts</h3>` + (sub
    ? `<p class="tg-on">✅ Phone alerts are on.</p><p class="muted">You get a notification when a new code is posted and before your pass ends.</p><button class="add" id="push-off" type="button">Turn off</button>`
    : denied ? '<p class="muted">Notifications are blocked for this site. Allow them in your browser settings, then come back.</p>'
    : `<p class="muted">Get a notification on this phone when a new code is posted, and a reminder before your pass ends.</p><button class="btn-primary" id="push-on" type="button">Turn on phone alerts</button>`);
}
document.addEventListener('click', async e => {
  const on = e.target.closest('#push-on'), off = e.target.closest('#push-off');
  if (!on && !off) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (on) {
      on.disabled = true;
      if ((await Notification.requestPermission()) !== 'granted') { toast('Alerts were not allowed'); return renderPush(); }
      const { key } = await api('/api/push/key');
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      toast('Phone alerts are on');
    } else {
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
      toast('Phone alerts are off');
    }
  } catch (err) { toast(err.message || 'Could not change phone alerts'); }
  renderPush();
});

// "Install the app" card: Android/desktop Chrome offer a real install prompt; iPhone needs the Share menu.
let installEvent = null;
const installDismissed = () => { try { return localStorage.getItem('pawa_install_off') === '1'; } catch { return false; } };
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; if (state.user) renderPosts(); });
window.addEventListener('appinstalled', () => { installEvent = null; if (state.user) renderPosts(); });
function installCard() {
  if (isStandalone() || installDismissed() || (!installEvent && !isIOS)) return '';
  return `<section class="install-card"><img src="logo.png" alt="" width="44" height="44"><div><b>Add PawaOdds to your phone</b>
    <span>${installEvent ? 'One tap, then open it like any app. Works with phone alerts.' : 'Tap the Share button, then <b>Add to Home Screen</b>.'}</span></div>
    ${installEvent ? '<button type="button" class="get" data-install>Install</button>' : ''}<button type="button" class="install-x" data-install-x aria-label="Hide">✕</button></section>`;
}
document.addEventListener('click', async e => {
  if (e.target.closest('[data-install-x]')) { try { localStorage.setItem('pawa_install_off', '1'); } catch { /* fine */ } return renderPosts(); }
  if (!e.target.closest('[data-install]') || !installEvent) return;
  installEvent.prompt(); try { await installEvent.userChoice; } catch { /* ignored */ }
  installEvent = null; renderPosts();
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
  try { state.results = await api('/api/results'); } catch { /* the results panel just stays hidden */ }
  try { state.refer = await api('/api/referrals'); } catch { /* the referral panel just stays hidden */ }
  renderPosts();
  if (resultsDialog.open) renderResults();
  if (state.open) { const p = state.posts.find(x => x.id === state.open); p ? openPost(p.id) : closeDialog(); }
}

const ICON = {
  vip: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M7 36l-2-20 12 10 7-14 7 14 12-10-2 20z"/><path d="M9 42h30"/></svg>',
  lock: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="10" y="21" width="28" height="21" rx="4"/><path d="M16 21v-6a8 8 0 0 1 16 0v6M24 29v6"/></svg>',
  daily: '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="8.5"/><path d="M24 5v6M24 37v6M5 24h6M37 24h6M10.6 10.6l4.2 4.2M33.2 33.2l4.2 4.2M37.4 10.6l-4.2 4.2M14.8 33.2l-4.2 4.2"/></svg>',
  long: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M15 8h18v10a9 9 0 0 1-18 0V8z"/><path d="M15 12H8c0 6 3 9 7 9M33 12h7c0 6-3 9-7 9M24 27v8M17 41h14M19 35h10"/></svg>',
};

// Hero art drawn in SVG: floodlit stadium, striped pitch and a gold football. (No photos, so nothing to license.)
const BALL_BODY = `<circle r="62" fill="url(#bg)"/><g clip-path="url(#bc)" fill="#10131C">
    <path d="M0-24l22.8 16.6-8.7 26.8H-14.1L-22.8-7.4z"/>
    <path d="M0-24V-62M22.8-7.4l36-11.7M14.1 19.4l22.3 30.7M-14.1 19.4L-36.4 50M-22.8-7.4l-36-11.7" stroke="#10131C" stroke-width="2.6" fill="none"/>
    <path d="M-47-52l20 3 4 22-18 6-14-16zM47-52l-20 3-4 22 18 6 14-16zM64 8l-5 24-20 4-8-20 14-14zM-64 8l5 24 20 4 8-20-14-14zM0 74l-22-10 2-22h40l2 22z"/></g>
  <circle r="62" fill="url(#bs)"/>`;
const BALL_DEFS = `<radialGradient id="bg" cx=".38" cy=".3" r=".85"><stop offset="0" stop-color="#fff"/><stop offset=".7" stop-color="#E9EDF5"/><stop offset="1" stop-color="#AEB8CC"/></radialGradient>
  <radialGradient id="bs" cx=".5" cy=".5" r=".5"><stop offset=".72" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".32"/></radialGradient>
  <clipPath id="bc"><circle r="62"/></clipPath>`;
// Hero art: bright floodlit stadium, grass, a football and blue/gold corner swooshes. Drawn here, so there is no photo to license.
const STADIUM = `<svg viewBox="0 0 420 340" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
  <defs>${BALL_DEFS}
    <linearGradient id="sk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#EAF2FF"/><stop offset=".45" stop-color="#7FB0FF"/><stop offset="1" stop-color="#1E56D6"/></linearGradient>
    <linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#58B83A"/><stop offset="1" stop-color="#1F7A22"/></linearGradient>
    <filter id="bz"><feGaussianBlur stdDeviation="2.6"/></filter><filter id="bz2"><feGaussianBlur stdDeviation="7"/></filter>
    <pattern id="cr" width="8" height="6" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" fill="#0B2A7A" opacity=".35"/><circle cx="6" cy="4.5" r="1" fill="#fff" opacity=".4"/></pattern>
  </defs>
  <rect width="420" height="340" fill="url(#sk)"/>
  <g filter="url(#bz2)"><path d="M120 150C220 100 380 70 420 90V215H120z" fill="#123E9C" opacity=".75"/><path d="M120 150C220 100 380 70 420 90V215H120z" fill="url(#cr)"/></g>
  <g filter="url(#bz)" fill="#fff">${Array.from({ length: 8 }, (_, i) => `<circle cx="${190 + i * 30}" cy="${108 - i * 8}" r="${4 + i * .35}"/>`).join('')}</g>
  <path d="M110 214C220 190 330 196 420 190V340H90z" fill="url(#gr)"/>
  ${Array.from({ length: 6 }, (_, i) => `<path d="M${130 + i * 60} 210l22 -2l${20 + i * 14} 132h-46z" fill="#fff" opacity=".08"/>`).join('')}
  <ellipse cx="356" cy="284" rx="50" ry="8" fill="#0B3A12" opacity=".45"/>
  <g transform="translate(358 232) scale(.76)">${BALL_BODY}</g>
  <path d="M0 0H92C60 30 28 60 0 74z" fill="#1D4ED8"/><path d="M0 74C28 60 64 28 92 0H112C78 36 40 70 0 92z" fill="#FFC21A"/>
  <path d="M420 340V258C380 292 330 322 258 340z" fill="#1D4ED8"/><path d="M420 258V236C372 280 320 316 244 340H258C330 322 380 292 420 258z" fill="#FFC21A"/>
</svg>`;
const BALL = `<svg viewBox="-80 -70 150 140" aria-hidden="true"><defs>${BALL_DEFS}<linearGradient id="sw" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE27A"/><stop offset="1" stop-color="#E59E00"/></linearGradient></defs>
  <path d="M-34-64C-82-48-84 38-30 62C-62 30-62-30-34-64z" fill="url(#sw)"/><path d="M-50-50C-84-20-80 36-44 58C-66 28-66-26-50-50z" fill="#FFC21A" opacity=".85"/>
  <g transform="translate(0 0) scale(.95)">${BALL_BODY}</g></svg>`;
const SI = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5v11l9-5.5z"/></svg>',
  cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h2M12 14h2M16 14h.1M8 17.5h2M12 17.5h2"/></svg>',
  doc: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M12 6h18l8 8v26a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="M30 6v8h8M16 20h14M16 26h14M16 32h8"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6-4.5-4.2 6.1-.8z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6l6 6-6 6"/></svg>',
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
  const long = p.kind === 'long', vip = false, locked = p.locked;
  const books = state.platforms.filter(b => p.books.includes(b.key));
  const created = new Date(p.createdAt.replace(' ', 'T') + (/[zZ]$/.test(p.createdAt) ? '' : 'Z')).getTime();
  const span = long ? Math.max(1, new Date(p.lastMatchAt) - created) : 0;
  const pct = long ? Math.min(100, Math.max(4, ((Date.now() - created) / span) * 100)) : 0;
  const label = vip ? 'Premium' : long ? 'Long bet' : 'Today';
  return `<button type="button" class="ticket ${long ? 'is-long' : ''} ${vip ? 'is-vip' : ''} ${locked ? 'is-locked' : ''}" ${locked ? 'data-unlock' : `data-post="${p.id}"`} style="--i:${i}">
    <span class="stub">${ICON[locked ? 'lock' : vip ? 'vip' : p.kind]}<small>${label}</small></span>
    <span class="body">
      <b class="t-title">${p.free ? '<i class="free-tag">FREE</i> ' : ''}${esc(p.title || (vip ? 'Premium slip' : long ? 'Long bet slip' : "Today's slip"))}</b>
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
  const ico = vip ? `<span class="ball-ico">${uniq(BALL)}</span>` : long ? SI.cup : SI.doc;
  return `<div class="ticket ghost">
    <span class="stub">${ico}${vip || long ? '' : '<small>Today</small>'}</span>
    <span class="body"><b class="t-title">${long ? 'No long bet open' : vip ? 'No premium slip yet' : 'Not posted yet'}</b>
      <span class="t-meta">${vip ? 'Premium slips with higher odds show here when they are posted.' : long ? 'Long bet slips will appear here soon.' : "Today's code will be available soon. Keep checking back for updates."}</span></span>
    ${vip || long ? `<span class="chev">${SI.chev}</span>` : ''}
  </div>`;
}

function renderPosts() {
  const daily = state.posts.filter(p => p.kind === 'daily'), long = state.posts.filter(p => p.kind === 'long');
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
        <p class="hello">${greeting()},${state.premium.active ? `<span class="vip-badge">${ICON.vip}Unlocked until ${esc(new Date(state.premium.until).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }))}</span>` : ''}</p>
        <h1>${live ? `${live} live slip${live === 1 ? '' : 's'}<br><em>ready</em> to load` : 'Your next slip<br><em>lands</em> here'}</h1>
        <p class="hero-sub">${live ? "Don't miss today's winning opportunities!" : "We'll show the next booking code here as soon as it's posted."}</p>
        <button type="button" class="hero-cta" data-scroll="slips">${live ? 'View Slips' : 'Stay Ready'} <i aria-hidden="true">›</i></button>
      </div>
      <span class="dots" aria-hidden="true"><i class="on"></i><i></i><i></i></span>
    </section>
    <div class="board" role="group" aria-label="Today at a glance">
      <div><span class="bi play">${SI.play}</span><b>${live}</b><span>Live Slips</span></div>
      <div><span class="bi cup">${SI.cup}</span><b>${state.platforms.length}</b><span>Bookmakers</span></div>
      <div><span class="bi clk">${SI.clock}</span><b class="clock" ${next ? `data-expires="${esc(next)}" data-short` : ''}>${next ? shortLeft(next) : '-'}</b><span>${next ? "Until Today's Code Closes" : 'Waiting for a code'}</span></div>
    </div>
    <div id="slips"></div>
    <section class="sect today">
      <header><span class="sect-ico">${SI.cal}</span><h2>Today's Booking Code</h2><time>${SI.cal}${esc(today)}<i aria-hidden="true">⌄</i></time></header>
      <div class="tickets">${daily.length ? daily.map(p => postCard(p, i++)).join('') : ghostTicket('daily')}</div>
    </section>
    <section class="sect long"><header><span class="sect-ico">${SI.bars}</span><h2>Long Bet Booking Code</h2></header>
      <div class="tickets">${long.length ? long.map(p => postCard(p, i++)).join('') : ghostTicket('long')}</div></section>
    ${arenaTile()}
    ${resultsPanel()}
    ${referPanel()}
    ${installCard()}
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
  $$('.dock button').forEach(x => x.classList.toggle('on', x === b && to !== 'account' && to !== 'alerts' && to !== 'results'));
  if (to === 'results') { document.querySelector('.dock [data-dock="home"]').classList.add('on'); return openResults(); }
  if (to === 'account' || to === 'alerts') document.querySelector('.dock [data-dock="home"]').classList.add('on');
  if (to === 'home') window.scrollTo({ top: 0, behavior: 'smooth' });
    if (to === 'alerts') $('#tg-open').click();
  if (to === 'account') $('#menu-btn').click();
});
document.addEventListener('click', e => { const s = e.target.closest('[data-scroll]'); if (s) $('#slips').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
function shortLeft(iso) { const ms = new Date(iso) - Date.now(); if (ms <= 0) return '0m'; const m = Math.floor(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; }
// Keep the countdowns ticking.
setInterval(() => $$('[data-expires]').forEach(el => { el.textContent = el.hasAttribute('data-short') ? shortLeft(el.dataset.expires) : remaining(el.dataset.expires); }), 20000);


// ---------- referrals ----------
function referPanel() {
  const r = state.refer;
  if (!r) return '';
  const left = r.target - r.progress;
  return `<section class="sect refer"><header><span class="sect-ico">${SI.hand}</span><h2>Refer &amp; Earn</h2></header>
    <div class="ref-pad"><p class="ref-line"><b>Get ${r.rewardMonths} months free.</b> Refer ${r.target} friends who buy a weekly or monthly pass and you never pay for ${r.rewardMonths} months.</p>
      <div class="ref-prog" aria-label="${r.progress} of ${r.target} referrals">${Array.from({ length: r.target }, (_, i) => `<i class="${i < r.progress ? 'on' : ''}"></i>`).join('')}<span>${r.progress}/${r.target}</span></div>
      <p class="muted ref-sub">${r.progress ? `${left} more to go.` : 'Share your code to start.'}${r.rewards ? ` You have earned free access ${r.rewards} time${r.rewards === 1 ? '' : 's'}.` : ''}</p>
      <button type="button" class="btn-primary ref-open" data-refer>${r.code ? 'Share my code' : 'Set my referral code'}</button></div></section>`;
}
const referDialog = $('#refer-dialog');
function referLink(code) { return location.origin + '/?ref=' + encodeURIComponent(code); }
function renderRefer() {
  const r = state.refer; if (!r) return;
  const link = r.code ? referLink(r.code) : '';
  const wa = r.code ? 'https://wa.me/?text=' + encodeURIComponent(`Get today's booking codes on PawaOdds. Sign up with my code ${r.code}: ${link}`) : '';
  $('#refer-body').innerHTML = `
    <p class="muted">Refer ${r.target} people who each buy a weekly or monthly pass and you get ${r.rewardMonths} months of every code free. It repeats for every ${r.target} you bring in.</p>
    <div class="ref-prog big">${Array.from({ length: r.target }, (_, i) => `<i class="${i < r.progress ? 'on' : ''}"></i>`).join('')}<span>${r.progress}/${r.target}</span></div>
    <form id="ref-form" class="ref-form"><label class="fld">${r.code ? 'Your referral code' : 'Choose your referral code'} <small>(a name, a number, anything)</small>
      <input id="ref-code" name="code" type="text" value="${esc(r.code)}" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="e.g. KOFI or 0241234567"></label>
      <p class="form-error" id="ref-err" role="alert"></p>
      <button type="submit" class="${r.code ? 'add' : 'btn-primary'}">${r.code ? 'Change code' : 'Save my code'}</button></form>
    ${r.code ? `<div class="ref-share"><div class="code-box"><div><span>Your link</span><b class="ref-link">${esc(link)}</b></div>
        <div class="code-actions"><button type="button" class="add solid" data-copy="${esc(link)}">Copy link</button></div></div>
      <a class="btn-primary" href="${esc(wa)}" target="_blank" rel="noopener">Share on WhatsApp</a>
      <p class="fineprint">Friends can also type <b>${esc(r.code)}</b> in the referral box when they sign up. Changing your code does not affect people already referred.</p></div>` : ''}
    <h3 class="ref-h">Your referrals (${r.joined})</h3>
    ${r.referred.length ? `<ul class="res-list">${r.referred.map(x => `<li><span class="rl-main"><b>${esc(x.who)}</b><small>Joined ${esc(new Date(x.joinedAt.replace(' ', 'T') + 'Z').toLocaleDateString([], { day: 'numeric', month: 'short' }))}</small></span><span class="res-badge ${x.purchased ? 'won' : ''}">${x.purchased ? 'Counted' : 'Not bought yet'}</span></li>`).join('')}</ul>` : '<p class="muted">No one yet. Share your link to get started.</p>'}
    <p class="fineprint">A referral counts once the person buys a weekly or monthly pass. Daily passes do not count.</p>`;
}
function openRefer() { renderRefer(); if (!referDialog.open) referDialog.showModal(); }
referDialog.addEventListener('click', e => { if (e.target === referDialog || e.target.closest('.refer-close')) referDialog.close(); });
referDialog.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#ref-form [type=submit]'); btn.disabled = true; $('#ref-err').textContent = '';
  try { state.refer = await api('/api/referrals/code', { method: 'PUT', body: { code: $('#ref-code').value.trim() } }); renderRefer(); renderPosts(); toast('Referral code saved'); }
  catch (err) { $('#ref-err').textContent = err.message; btn.disabled = false; }
});

// ---------- results center ----------
const RES_LABEL = { won: 'Won', lost: 'Lost', void: 'Void', pending: 'Awaiting' };
const resultDots = items => items.filter(x => x.status === 'won' || x.status === 'lost').slice(0, 10).reverse().map(x => `<i class="rd ${x.status}" title="${RES_LABEL[x.status]}"></i>`).join('');
function resultsPanel() {
  const r = state.results;
  if (!r) return '';
  const dots = resultDots(r.items);
  return `<section class="sect results"><header><span class="sect-ico">${SI.bars}</span><h2>Results Center</h2></header>
    <div class="res-sum">
      <div class="res-rate"><b>${r.rate === null ? '-' : r.rate + '%'}</b><span>Win rate, last ${r.days} days</span></div>
      <div class="res-tiles"><div><b>${r.won}</b><span>Won</span></div><div><b>${r.lost}</b><span>Lost</span></div><div><b>${r.streak}</b><span>Winning run</span></div></div>
    </div>
    ${dots ? `<div class="res-dots" aria-label="Latest results">${dots}</div>` : '<p class="muted res-none">Results show up here once codes are settled.</p>'}
    <button type="button" class="add res-all" data-results>See all results</button></section>`;
}
const resultsDialog = $('#results-dialog');
function renderResults() {
  const r = state.results; if (!r) return;
  const day = d => new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  $('#results-body').innerHTML = `
    <div class="res-sum big">
      <div class="res-rate"><b>${r.rate === null ? '-' : r.rate + '%'}</b><span>Win rate, last ${r.days} days</span></div>
      <div class="res-tiles"><div><b>${r.won}</b><span>Won</span></div><div><b>${r.lost}</b><span>Lost</span></div><div><b>${r.void}</b><span>Void</span></div><div><b>${r.streak}</b><span>Winning run</span></div></div>
    </div>
    ${r.items.length ? `<ul class="res-list">${r.items.map(x => `<li><span class="rl-main"><b>${esc(x.title || (x.kind === 'long' ? 'Long bet' : "Today's code"))}</b><small>${x.kind === 'long' ? 'Long bet' : 'Today'} · ${esc(day(x.date))}</small></span><span class="res-badge ${x.status}">${RES_LABEL[x.status]}</span>${x.status === 'won' ? `<button type="button" class="share-win" data-share="${x.id}" aria-label="Share this win">Share</button>` : ''}</li>`).join('')}</ul>`
      : '<p class="muted">No results yet. They appear as soon as codes are settled.</p>'}
    <p class="fineprint">Results are marked by the PawaOdds team after the games finish. Past results do not guarantee future wins. 18+ only. Bet responsibly.</p>`;
}
function openResults() { renderResults(); if (!resultsDialog.open) resultsDialog.showModal(); }
resultsDialog.addEventListener('click', e => { if (e.target === resultsDialog || e.target.closest('.results-close')) resultsDialog.close(); });

// ---------- premium ----------
const CUR = { GHS: 'GH₵', NGN: '₦', ZAR: 'R', KES: 'KSh', USD: '$' };
const money = n => (CUR[state.premium.currency] || state.premium.currency + ' ') + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

const fmtDay = d => new Date(d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
let chosenPlan = 'weekly';
const planOf = () => state.premium.plans.find(x => x.key === chosenPlan) || state.premium.plans.find(x => x.key === 'weekly') || state.premium.plans[0];
const planName = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

function vipBanner() {
  const pr = state.premium;
  if (pr.active && pr.endsSoon && pr.enabled) {
    return `<section class="vip-banner is-soon"><div class="vip-copy"><span class="vip-crown">${ICON.vip}</span><b>Your pass ends soon</b>
      <span>It runs out ${esc(new Date(pr.until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}. Renew to keep every code.</span></div>
      <button type="button" class="get" data-unlock>Renew</button></section>`;
  }
  if (pr.active) {
    return `<section class="vip-banner is-active"><div><b>All codes unlocked</b><span>Your pass runs until ${esc(fmtDay(pr.until))}. Every code and long bet is open.</span></div></section>`;
  }
  const low = pr.plans.length ? Math.min(...pr.plans.map(x => x.price)) : 0;
  return `<section class="vip-banner"><div class="vip-copy"><span class="vip-crown">${ICON.vip}</span>
      <b>Unlock every code</b><span>Today's codes and long bets from ${low ? esc(money(low)) : 'a small fee'}: daily, weekly or monthly.</span></div>
    ${pr.enabled ? '<button type="button" class="get" data-unlock>Subscribe</button>' : '<span class="soon">Coming soon</span>'}</section>`;
}

const premiumDialog = $('#premium-dialog');
let promo = null, promoText = '';
const planPrice = x => (promo && promo.plans[x.key]) ? promo.plans[x.key].price : x.price;
function planPicker(msg) {
  const pr = state.premium, cur = planOf();
  const email = $('#pay-email') ? $('#pay-email').value : '';
  if ($('#promo-code')) promoText = $('#promo-code').value;
  $('#premium-body').innerHTML = `
    <p class="muted">${pr.active ? 'Renew to keep every booking code. Your days are added after the ones you have left.' : "Subscribe to unlock today's booking codes and the long bets."}</p>
    <div class="plan-list" role="radiogroup" aria-label="Choose a plan">${pr.plans.map(x => `
      <button type="button" class="plan" role="radio" aria-checked="${x.key === cur.key}" data-plan="${x.key}">
        <span><b>${planName[x.key] || esc(x.name)}</b><small>${x.key === 'daily' ? 'Until midnight tonight' : x.key === 'weekly' ? '1 week, Monday to Sunday' : '30 days'}</small></span>
        <span class="price">${planPrice(x) !== x.price ? `<s>${esc(money(x.price))}</s> ` : ''}${esc(money(planPrice(x)))}</span>${x.key === 'weekly' ? '<em>Popular</em>' : ''}</button>`).join('')}</div>
    <div class="promo-row"><input id="promo-code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" placeholder="Promo code (optional)" value="${esc(promoText)}"><button type="button" class="add" id="promo-apply">Apply</button></div>
    <p class="promo-msg ${promo ? 'ok' : ''}" id="promo-msg" role="status">${esc(msg || (promo ? `${promo.code}: ${promo.percent}% off applied` : ''))}</p>
    <ul class="vip-perks"><li>Today's booking codes for your bookmaker</li><li>Long bet booking codes</li><li>Valid until ${esc(fmtDay(new Date(new Date(cur.endsAt).getTime() - 1)))}, no auto-renewal</li></ul>
    <label class="fld">Email for your receipt <small>(optional)</small><input id="pay-email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="${esc(email)}"></label>
    <button type="button" class="btn-primary" id="pay-go">${pr.active ? 'Renew' : 'Subscribe'} ${esc(money(planPrice(cur)))}</button>
    <p class="fineprint">You'll pay on Paystack's secure page with mobile money or card. We never see your card or MoMo PIN.</p>`;
}
async function applyPromo() {
  const code = $('#promo-code').value.trim(); promoText = code;
  if (!code) { promo = null; return planPicker(); }
  const btn = $('#promo-apply'); btn.disabled = true;
  try { promo = await api('/api/premium/promo', { method: 'POST', body: { code } }); promoText = promo.code; planPicker(); }
  catch (err) { promo = null; planPicker(err.message); $('#promo-msg').classList.add('bad'); }
}
function openPremium() {
  const pr = state.premium;
  if (pr.active && !pr.endsSoon) { toast('You are subscribed. All codes are unlocked until ' + fmtDay(pr.until) + '.'); return; }
  if (!pr.enabled || !pr.plans.length) { toast('Subscriptions are not open yet. Check back soon.'); return; }
  planPicker(); trackPayView();
  if (!premiumDialog.open) premiumDialog.showModal();
}
async function startPayment() {
  const btn = $('#pay-go'); btn.disabled = true; btn.textContent = 'Opening Paystack…';
  try {
    const r = await api('/api/premium/checkout', { method: 'POST', body: { plan: planOf().key, email: $('#pay-email').value.trim(), promo: promo && promo.plans[planOf().key] ? promo.code : undefined, returnUrl: location.origin + '/' } });
    if (r.free) { premiumDialog.close(); promo = null; promoText = ''; await loadPosts(); return toast('Promo applied. All codes are unlocked.', 5000); }
    try { sessionStorage.setItem('oddsday_pay', r.reference); } catch { /* fine */ }
    location.href = r.url;
  } catch (err) { btn.disabled = false; btn.textContent = (state.premium.active ? 'Renew ' : 'Subscribe ') + money(planPrice(planOf())); toast(err.message, 5000); }
}
premiumDialog.addEventListener('click', e => {
  const pl = e.target.closest('[data-plan]');
  if (pl) { chosenPlan = pl.dataset.plan; planPicker(); return; }
  if (e.target.closest('#promo-apply')) return applyPromo();
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
    toast(r.paid ? 'Payment received. All codes are unlocked.' : 'Payment not completed. You were not charged.', 5000);
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
      ${loadHref(b, e.code) ? `<a class="btn-primary slip-link" data-load="${esc(e.code)}" href="${esc(loadHref(b, e.code))}" target="_blank" rel="noopener">Load code in ${esc(b.name)}</a>` : ''}
      ${e.link ? `<a class="btn-primary slip-link" href="${esc(e.link)}" target="_blank" rel="noopener noreferrer">Open the slip on ${esc(b.name)}</a>` : ''}
      ${b.url ? `<a class="add" href="${esc(b.url)}" target="_blank" rel="noopener">Open ${esc(b.name)}</a>` : ''}
      <p class="fineprint">On ${esc(b.name)}, open the betslip, enter the booking code and load it. Odds may differ slightly. 18+ only. Bet responsibly.</p>`;
    const img = $('img[data-img]', body);
    if (img) loadImage(img);
  }
  if (!postDialog.open) postDialog.showModal();
}

// A bookmaker's share link that loads the code straight onto the betslip (only when set up and the code looks like a plain code).
function loadHref(b, code) {
  const c = String(code || '').trim();
  return b.loadUrl && /^[A-Za-z0-9]{3,20}$/.test(c) ? b.loadUrl.replace('{code}', encodeURIComponent(c)) : '';
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
  if (e.target.closest('[data-refer]')) return openRefer();
  if (e.target.closest('[data-results]')) return openResults();
  const ld = e.target.closest('[data-load]');
  if (ld) { try { navigator.clipboard.writeText(ld.dataset.load); } catch { /* the code is also shown on screen */ } toast('Code copied. Opening the betslip...'); return; }
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


// ---------- share a win ----------
// Draws a branded picture of the win (nothing but the title, date and the person's own referral code) and shares it.
async function winCard(item) {
  const W = 1080, H = 1080, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), r = state.results || {};
  const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#0B2466'); bg.addColorStop(1, '#06143A'); g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(245,179,1,.10)'; g.beginPath(); g.arc(W - 120, 160, 420, 0, 7); g.fill();
  try { const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = 'logo.png'; }); g.drawImage(img, 70, 60, 150, 150); } catch { /* the card still works without the logo */ }
  g.textBaseline = 'alphabetic'; g.fillStyle = '#fff'; g.font = '800 64px system-ui, sans-serif'; g.fillText('Pawa', 250, 150); const w = g.measureText('Pawa').width;
  g.fillStyle = '#F5B301'; g.fillText('Odds', 250 + w, 150); g.fillStyle = '#9FB0E6'; g.font = '600 30px system-ui, sans-serif'; g.fillText('Play Smart, Win Big', 250, 196);
  g.fillStyle = '#12A150'; g.beginPath(); g.roundRect(70, 330, 330, 120, 60); g.fill();
  g.fillStyle = '#fff'; g.font = '900 64px system-ui, sans-serif'; g.fillText('WON ✓', 110, 410);
  g.font = '800 76px system-ui, sans-serif'; g.fillStyle = '#fff';
  const title = item.title || (item.kind === 'long' ? 'Long bet' : "Today's code"), words = title.split(' '), lines = []; let line = '';
  for (const wd of words) { if (g.measureText((line + ' ' + wd).trim()).width > W - 140) { lines.push(line); line = wd; } else line = (line + ' ' + wd).trim(); } lines.push(line);
  lines.slice(0, 3).forEach((l, i) => g.fillText(l, 70, 580 + i * 92));
  g.fillStyle = '#9FB0E6'; g.font = '600 38px system-ui, sans-serif';
  g.fillText(new Date(item.date + 'T12:00:00').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }), 70, 600 + Math.min(lines.length, 3) * 92);
  if (r.rate != null) { g.fillStyle = '#F5B301'; g.font = '800 44px system-ui, sans-serif'; g.fillText(`${r.rate}% win rate, last ${r.days} days`, 70, 880); }
  const code = state.refer && state.refer.code;
  g.fillStyle = '#fff'; g.font = '700 40px system-ui, sans-serif'; g.fillText(location.host, 70, 980);
  if (code) { g.fillStyle = '#F5B301'; g.font = '700 34px system-ui, sans-serif'; g.fillText('Join with my code ' + code, 70, 1030); }
  return new Promise(ok => c.toBlob(ok, 'image/png'));
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-share]'); if (!b) return;
  const item = state.results && state.results.items.find(x => x.id === Number(b.dataset.share)); if (!item) return;
  b.disabled = true;
  try {
    const blob = await winCard(item), file = new File([blob], 'pawaodds-win.png', { type: 'image/png' });
    const code = state.refer && state.refer.code, text = `Another win on PawaOdds ✅ ${location.origin}${code ? '/?ref=' + encodeURIComponent(code) : ''}`;
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], text });
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pawaodds-win.png'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast('Picture saved. Share it on WhatsApp or Facebook.'); }
  } catch (err) { if (err && err.name !== 'AbortError') toast('Could not make the picture'); }
  b.disabled = false;
});

// ---------- tell the server the plan screen was opened (for the funnel) ----------
function trackPayView() { api('/api/track', { method: 'POST', body: { kind: 'pay_view' } }).catch(() => { /* not important */ }); }

// ---------- Arena Picks (the play-coins game, arena.html) ----------
function arenaTile() {
  return `<a class="arena-tile" href="arena.html"><span class="arena-ico" aria-hidden="true">🏁🎡</span><span class="arena-txt"><b>Arena Picks</b><small>Race and Spin games with free play coins. Daily bonus inside.</small></span><span class="get">Play<i aria-hidden="true">›</i></span></a>`;
}
