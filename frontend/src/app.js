// OddsDay public app — plain JavaScript, no build step.
// Talks to the API at ODDSDAY_CONFIG.apiUrl (see config.js).
const API_URL = ((window.ODDSDAY_CONFIG && window.ODDSDAY_CONFIG.apiUrl) || '').replace(/\/$/, '');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { user: null, posts: [], platforms: [], open: null };

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

function showAuth() { $('#app-view').hidden = true; $('#auth-view').hidden = false; }

// ---------- shell ----------
async function startApp() {
  const me = await api('/api/me');
  state.user = me.user;
  $('#auth-view').hidden = true; $('#app-view').hidden = false;
  $('#top-date').textContent = new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  $('#avatar').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M4.5 20c.8-4 3.7-6 7.5-6s6.7 2 7.5 6"/></svg>';
  $('#menu-name').textContent = state.user.name;
  $('#tg-open').hidden = !me.telegram;
  await loadPosts();
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
  state.posts = r.posts; state.platforms = r.platforms;
  renderPosts();
  if (state.open) { const p = state.posts.find(x => x.id === state.open); p ? openPost(p.id) : closeDialog(); }
}

function postCard(p) {
  const long = p.kind === 'long';
  const names = state.platforms.filter(b => p.entries[b.key]).map(b => esc(b.name)).join(' · ');
  const until = long ? `Open until the last match is played (${esc(fmtWhen(p.lastMatchAt))})` : `Updated ${esc(fmtWhen(p.createdAt.replace(' ', 'T') + (p.createdAt.includes('Z') ? '' : 'Z')))}`;
  return `<button type="button" class="post-card ${long ? 'is-long' : ''}" data-post="${p.id}">
    <span class="post-kind">${long ? 'Long bet booking code' : "Today's booking code"}</span>
    <b class="post-title">${esc(p.title || (long ? 'Long bet' : 'Today'))}</b>
    <span class="post-meta">${until}</span>
    <span class="post-books">${names || 'No bookmakers yet'}</span>
    <span class="post-go">Tap to choose your bookmaker <i aria-hidden="true">›</i></span>
  </button>`;
}

function renderPosts() {
  const daily = state.posts.filter(p => p.kind === 'daily'), long = state.posts.filter(p => p.kind === 'long');
  const section = (title, list, none) => `<h2 class="section-head">${title}</h2>` + (list.length ? `<div class="list">${list.map(postCard).join('')}</div>` : `<div class="empty">${none}</div>`);
  $('#posts').innerHTML = section("Today's booking code", daily, "Today's code hasn't been posted yet. Check back soon.")
    + section('Long bet booking code', long, 'No long bet is open right now.');
}

// Tap a post: choose a bookmaker, then see that bookmaker's code.
const postDialog = $('#post-dialog');
function closeDialog() { state.open = null; if (postDialog.open) postDialog.close(); }

function openPost(id, platform) {
  const p = state.posts.find(x => x.id === id); if (!p) return;
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
