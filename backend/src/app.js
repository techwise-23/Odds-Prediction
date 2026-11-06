// Builds the Express app. API only: the websites live in ../../frontend and ../../admin.
const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');
const cors = require('./middleware/cors');

const app = express();
// Behind Render/Railway/nginx set TRUST_PROXY=1 so rate limits see each visitor's real IP.
// In production the app always sits behind Railway's proxy. Without this every visitor shared the proxy's IP, so the
// 20-attempts-per-15-minutes limit on sign up / log in was shared by everyone and quickly locked people out.
const trustProxy = process.env.TRUST_PROXY || (process.env.NODE_ENV === 'production' ? '1' : '');
if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

app.disable('x-powered-by');
app.use(cors);
app.use(express.json());
app.use(cookieParser());

// Health check for Railway and uptime monitors.
app.get('/health', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true, uptime: Math.round(process.uptime()) }); });
app.get('/', (req, res) => res.json({ name: 'OddsDay API', ok: true }));

app.use('/api/admin', require('./routes/admin'));   // admin console (own login + session)
app.use('/api', require('./routes/auth'));          // sign up, log in, account settings, Telegram
app.use('/api', require('./routes/picks'));         // picks, tickets, dashboard, record, slip

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
module.exports = app;
