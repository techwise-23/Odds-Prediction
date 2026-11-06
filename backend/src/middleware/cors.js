// Lets the separate frontend and admin sites call this API from the browser.
// Only origins listed in CORS_ORIGINS get access; cookies are allowed for them.
const config = require('../config');

module.exports = function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    const allowed = config.corsOrigins.includes(origin);
    if (allowed) {
      res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600' });
    } else if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      // A browser page from an unknown site must not change anything, even if it somehow holds a cookie.
      return res.status(403).json({ error: 'Origin not allowed' });
    }
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};
