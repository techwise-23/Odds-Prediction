const express = require('express');
const arena = require('../arena');
const { auth, limited } = require('../middleware/auth');
const db = require('../db');
const router = express.Router();

const run = fn => (req, res) => Promise.resolve().then(() => fn(req)).then(r => res.json(r)).catch(e => res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }));
router.get('/arena/wallet', auth, run(req => arena.wallet(req.user.id)));
router.post('/arena/spin', auth, run(req => arena.spin(req.user.id, req.body && req.body.picks, req.body && req.body.stake)));
router.post('/arena/race', auth, run(req => arena.race(req.user.id, req.body && req.body.pick, req.body && req.body.stake)));
router.get('/arena/leaders', auth, run(req => ({ leaders: arena.leaders(req.user.id) })));
router.post('/arena/buy', auth, limited, run(req => arena.buy(req.user, req.body && req.body.price, { email: req.body && req.body.email, callbackUrl: req.body && req.body.returnUrl })));
router.post('/arena/verify', auth, run(async req => {
  const own = db.prepare('SELECT 1 FROM arena_orders WHERE reference = ? AND user_id = ?').get(String(req.body && req.body.reference || ''), req.user.id);
  if (!own) throw Object.assign(new Error('Payment not found for your account'), { status: 404 });
  const r = await arena.verify(req.body.reference);
  return { paid: r.paid, state: r.state || (r.paid ? 'success' : 'pending'), wallet: arena.wallet(req.user.id) };
}));
router.post('/arena/kyc', auth, limited, run(req => require('../arena').saveKyc(req.user.id, req.body || {})));
router.post('/arena/convert', auth, run(req => require('../arena').convert(req.user.id, req.body && req.body.coins)));
router.post('/arena/withdraw', auth, limited, run(req => { require('../pin').verify(req.user.id, req.body && req.body.pin); return require('../arena').withdraw(req.user, req.body && req.body.amount, String(req.body && req.body.network || '')); }));
module.exports = router;
