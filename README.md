# OddsDay

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
   The Volume is what keeps your database between deploys: without it every redeploy starts empty.
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
