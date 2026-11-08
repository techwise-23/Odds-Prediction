# PawaOdds

Daily football predictions sorted by odds band, with ready-made accumulators and booking codes.
Three separate apps that talk to each other over HTTP:

```
oddsday/
├── backend/    API + database + daily jobs + Telegram bot   (Node, Express, SQLite)  :3000
├── frontend/   The public app users see                      (static HTML/JS/CSS)     :5173
└── admin/      Admin console (codes, users, run jobs)        (static HTML/JS/CSS)     :5174
```

| | backend | frontend | admin |
|---|---|---|---|
| Who uses it | both sites | everyone | you |
| Login | `/api/login` (phone) | cookie `bp_session` | `/api/admin/login` (phone + passcode), cookie `bp_admin` |
| Session | 30 days | | 12 hours |
| Deploy as | Node service + volume | static site / tiny Node server | static site / tiny Node server |

The admin console has its **own login and session**. Being logged in to the public app does not log you in
to the admin, and the admin API refuses public-app sessions.

## How booking codes work now

The system no longer generates tickets or codes. **You** book the games on each betting app and post the code in the admin console
(Booking codes tab). There are two kinds of post:

- **Today's booking code**: removed automatically at 12:00 noon the next day (change with `POST_EXPIRE_HOUR`, default `12`, in `TZ_NAME` time).
- **Long bet booking code**: you enter the kickoff of the **last match**; the post stays until 3 hours after that (`LONG_BET_GRACE_HOURS`).

For each betting company you can add a **code**, a **link**, or an **image** (the code you type becomes its caption). Users tap a post,
choose their bookmaker, and see that company's code. Expired posts are deleted every 5 minutes.
Set `AUTO_PREDICTIONS=1` on the backend to bring the old generated picks back (the public app no longer shows them).
Note: `npm run build:phone` (the single-file offline app) was not updated for booking codes.

## Weekly pass (Paystack)

Every booking code is locked until the user subscribes. Tapping a code opens a prompt: a choice of **GH₵15 daily, GH₵50 weekly (Monday to Sunday) or GH₵120 monthly (30 days)**, with a
Subscribe button that opens Paystack checkout (mobile money or card). When payment is confirmed everything unlocks until the end of
that Sunday (app time zone, default Africa/Accra). There is no auto-renewal. Admins always see the codes.

Backend variables:

| Variable | What it does |
| --- | --- |
| `PAYSTACK_SECRET_KEY` | Your Paystack secret key (`sk_live_...`). Payments stay off until it is set. |
| `PAYSTACK_CURRENCY` | Default `GHS`. |
| `PREMIUM_PRICE_DAILY` / `_WEEKLY` / `_MONTHLY` | Pass prices in whole cedis. Defaults 15 / 50 / 120. Set one to `0` to hide it. Daily lasts until midnight, weekly until the end of Sunday, monthly 30 days. |
| `SITE_URL` | The frontend's address. Paystack sends people back here after paying. |

In the Paystack dashboard (Settings → API Keys & Webhooks) set the **Webhook URL** to `https://<your-backend>/api/paystack/webhook`.
The webhook means subscribers still get access if they close the page right after paying. Access is only ever granted after the
server confirms the payment and the exact amount with Paystack. Test first with your `sk_test_...` key.

## Run it locally

Needs Node.js 20+.

```bash
cd backend && npm install && cp .env.example .env && cd ..
npm run dev          # starts all three
```

- Public app: http://localhost:5173
- Admin console: http://localhost:5174
- API: http://localhost:3000 (`/health` to check it)

Without `API_FOOTBALL_KEY` the API runs in demo mode with sample games. The first account created on the
public app becomes an admin (or set `ADMIN_PHONES`); then sign in to the admin console with that number.

Or with Docker: `cp backend/.env.example backend/.env && docker compose up --build`.

## How the apps find each other

- **frontend / admin → backend:** `src/config.js` in each holds `apiUrl` (default `http://localhost:3000`).
  When you run `npm start` in `frontend/` or `admin/`, set `API_URL=https://api.yoursite.com` and the server
  writes that into `/config.js` for you, so no rebuild is needed.
- **backend → frontend / admin:** `CORS_ORIGINS` lists the two site addresses allowed to call the API.
  Requests from any other site are refused.
- **Cookies:** use `COOKIE_SAMESITE=lax` when the three share a domain (`app.x.com`, `admin.x.com`, `api.x.com`).
  If they sit on unrelated domains (for example three separate `*.up.railway.app` hosts) use `COOKIE_SAMESITE=none`
  (HTTPS required). `COOKIE_DOMAIN=.x.com` is optional.

## Deploy (Railway example)

Create three services from the same repo. **Each service must have its Root Directory set** (Settings → Source →
Root Directory = `backend`, `frontend` or `admin`). Without it Railway looks for a Dockerfile at the repo root, finds none
and the build fails.

1. **backend** (root `backend/`): add a Volume mounted at `/data`. Variables: `JWT_SECRET` (`openssl rand -hex 32`; if you forget it, a random one is created and kept on the Volume),
   `ADMIN_PHONES`, `ADMIN_PASSCODE`, `TRUST_PROXY=1`, `CORS_ORIGINS=https://app.x.com,https://admin.x.com`,
   `COOKIE_SAMESITE` (see above), `SITE_URL=https://app.x.com`, optional `API_FOOTBALL_KEY`, `TELEGRAM_BOT_TOKEN`.
   **The Volume is what keeps your users between deploys.** Without it, every update you push to GitHub starts Railway with an empty database and all accounts disappear. Backend service → Volumes → New Volume (any mount path, `/data` is fine). The app finds it by itself, warns in the logs and in the admin console if it is missing, and keeps its secrets and database on it.
   Keep it at **1 replica** (the daily jobs and Telegram polling run inside it).
2. **frontend** (root `frontend/`): variable `API_URL=https://api.x.com`.
3. **admin** (root `admin/`): variable `API_URL=https://api.x.com`.

Each folder has its own `Dockerfile` and `railway.json`. The frontend and admin are plain static files in `src/`,
so Netlify, Cloudflare Pages or any static host also works: just edit `src/config.js`.

**Signup says "Failed to fetch"?** The browser can't reach the API. Check, in order: (1) the frontend service has `API_URL` set to the
backend's public address; (2) the backend has `CORS_ORIGINS` listing the frontend and admin addresses; (3) the backend is
running (open `<backend address>/health`). Addresses may be typed with or without `https://` or a trailing slash. In production
cookies default to `SameSite=none`, which works across separate `*.up.railway.app` hosts.

**Set an admin passcode in production** (`ADMIN_PASSCODE`, or in Settings). Logins use a phone number only, so without a passcode anyone who knows
an admin's number can open the admin console. The admin overview warns you until it is set.

## Phone version (single HTML file)

`npm run build:phone` writes `frontend/dist/oddsday.html`: the public app plus an in-browser copy of the backend
and sample games, which runs on one phone with no server. It reuses `backend/src/model.js`, `demo.js` and `phone.js`.

## Backend layout

```
backend/src/
  server.js          starts the API, daily schedule, Telegram polling
  app.js             Express app: CORS, JSON, routes
  routes/auth.js     sign up, log in, account, Telegram settings
  routes/picks.js    picks, tickets, dashboard, record, slip
  routes/admin.js    admin login + codes, overview, users, runs
  middleware/        auth (two sessions), cors
  services/tickets.js  shared queries
  engine.js  model.js  providers.js  apiFootball.js  demo.js  notify.js  telegram.js  db.js  config.js
```

See `backend/.env.example` for every setting, and the old notes on how the predictions work are unchanged:
Poisson model blended 50/50 with bookmaker prices, one pick per game per odds band, tickets built from the best
odds-per-risk legs. Booking codes are pasted in by hand in the admin console (the bookmakers have no public API).

## What the admin console controls

Sign in to the admin console and open **Settings**. Everything below is saved in the database and takes effect
straight away (schedules restart, the Telegram bot reconnects). A value saved there replaces the matching server
variable until you press **Reset to server default**.

| Section | You can change |
|---|---|
| Data and alerts | API-Football key, odds bookmaker id, Telegram bot token, site address, with Test buttons |
| Schedule | time zone, daily prediction time, how often finished games are settled |
| Odds bands | name, lowest and highest odds and lowest chance for Low, Medium and High |
| Tickets | add, edit or remove the daily tickets (target odds, number of games, which bands to use, where shown) |
| Bookmakers | add, edit or remove bookmakers and their "Open" links |
| Leagues | add or remove the competitions that get predictions |
| Admin passcode | set or remove it (stored hashed) |

Elsewhere in the console: **Users** (add, delete, make or remove admin, message everyone on Telegram) and
**Codes** (paste codes, delete a ticket). **Activity** also shows a log of what admins changed.

Kept on the server on purpose: `JWT_SECRET`, `CORS_ORIGINS`, cookie settings, `DB_FILE`, `PORT`. A wrong value in any of
these can lock everyone out. Locked out by a forgotten passcode? Run `node src/cli.js reset-passcode` in `backend/`.

## Before launching

Check the betting and advertising rules where you operate (in Ghana, the Gaming Commission), keep the 18+ notice,
and consider adding links to local problem-gambling support. No model beats bookmakers reliably, and long
accumulators lose most of the time; the Record page shows real results.


### Loading a code straight into a bookmaker

On a booking code, users get a **Load code in SportyBet** button that opens `https://www.sportybet.com/gh/?shareCode=<code>` and also copies the code. To add the same for another bookmaker, set `LOAD_URL_MSPORT`, `LOAD_URL_FOOTBALLCOM` or `LOAD_URL_BETWAY` (or `LOAD_URL_SPORTYBET` to change SportyBet's) on the backend to that bookmaker's share link with `{code}` where the code goes.


### Results center

Every posted code gets a result row that stays after the post expires. In the admin console (Codes tab, **Results**) tap **Won**, **Lost** or **Void** once the games finish. Users see the 30-day win rate, winning run and the latest results on the home screen and under the **Results** tab. Codes themselves are never shown there.
