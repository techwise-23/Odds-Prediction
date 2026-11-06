const express = require('express');
const config = require('../config');
const premium = require('../premium');
const { auth, limited } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();

// Where Paystack sends the person after paying: only our own sites.
function returnUrl(req) {
  const want = String((req.body && req.body.returnUrl) || '');
  try { const o = new URL(want).origin; if (config.corsOrigins.includes(o) || o === config.siteUrl.replace(/\/+$/, '')) return o + '/'; } catch { /* fall through */ }
  return config.siteUrl ? config.siteUrl.replace(/\/+$/, '') + '/' : undefined;
}

router.post('/premium/checkout', auth, limited, async (req, res) => {
  try {
    const r = await premium.checkout(req.user, String(req.body.plan || ''), { email: req.body.email, callbackUrl: returnUrl(req) });
    res.json({ url: r.url, reference: r.reference });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not start the payment' }); }
});

// The browser comes back from Paystack with ?reference=...; we confirm it with Paystack before unlocking anything.
router.post('/premium/verify', auth, async (req, res) => {
  try {
    const own = db.prepare('SELECT 1 FROM payments WHERE reference = ? AND user_id = ?').get(String(req.body.reference || ''), req.user.id);
    if (!own) return res.status(404).json({ error: 'Payment not found for your account' });
    const r = await premium.verify(req.body.reference);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ paid: r.paid, state: r.state || (r.paid ? 'success' : 'pending'), premium: premium.status(fresh) });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not confirm the payment' }); }
});

// Paystack -> us. Signed with HMAC-SHA512 of the raw body using the secret key.
router.post('/paystack/webhook', async (req, res) => {
  if (!premium.webhookValid(req.rawBody, req.get('x-paystack-signature'))) return res.sendStatus(401);
  res.sendStatus(200); // answer fast; Paystack retries on anything but 200
  try {
    if (req.body && req.body.event === 'charge.success' && req.body.data && req.body.data.reference) await premium.verify(req.body.data.reference);
  } catch (e) { console.error('paystack webhook:', e.message); }
});

module.exports = router;
