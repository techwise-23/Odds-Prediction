// Tiny static file server for the admin console (no dependencies). Any static host works too.
// Env: PORT (default 5174), API_URL (written into /config.js so one build works in any environment).
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'src');
const port = Number(process.env.PORT || 5174);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  if (url === '/config.js' && process.env.API_URL !== undefined) {
    res.writeHead(200, { 'Content-Type': types['.js'], 'Cache-Control': 'no-store' });
    return res.end(`window.ODDSDAY_CONFIG = ${JSON.stringify({ apiUrl: process.env.API_URL })};\n`);
  }
  let file = path.join(root, url === '/' ? 'index.html' : url);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html'); // single-page fallback
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`OddsDay admin on http://localhost:${port} (API: ${process.env.API_URL ?? 'from src/config.js'})`));
