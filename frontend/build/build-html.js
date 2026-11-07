// Builds dist/oddsday.html: the whole public app in one file that runs on a phone with no server.
// It bundles a small in-browser copy of the backend (build/local-api.js) and the backend's model + demo data.
// Usage: npm run build:html   (run inside frontend/)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');                 // frontend/
const backend = path.join(root, '..', 'backend', 'src'); // shared model, demo data, phone helpers
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const readBackend = f => fs.readFileSync(path.join(backend, f), 'utf8');
const config = require(path.join(backend, 'config'));

const shared = {
  tiers: config.tiers, accas: config.accas, leagues: config.leagues,
  platforms: config.platforms.map(({ key, name, url }) => ({ key, name, url })),
};
const wrap = (src, name) => `const ${name} = (() => { const module = { exports: {} }; ${src}\n; return module.exports; })();`;

const script = [
  `const CONFIG = ${JSON.stringify(shared)};`,
  wrap(readBackend('model.js'), 'Model'),
  wrap(readBackend('phone.js'), 'Phone'),
  wrap(readBackend('demo.js'), 'makeDemo'),
  read('build/local-api.js'),
  read('src/app.js'),
].join('\n\n').replace(/<\/script/gi, '<\\/script');

let html = read('src/index.html')
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${read('src/styles.css')}\n</style>`)
  .replace('<script src="config.js"></script>\n  ', '')
  .replace('<script src="app.js"></script>', () => `<script>\n${script}\n</script>`)
  .replace(/<title>[^<]*<\/title>/, '<title>PawaOdds</title>');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'oddsday.html'), html);
console.log(`dist/oddsday.html written (${(html.length / 1024).toFixed(0)} KB)`);

// Version for publishing as a claude.ai artifact: no html/head/body wrapper (the host adds one,
// and pads the top of the page for the phone's notch, so the sticky header sits below it).
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1]
  .replace(/<meta charset[^>]*>|<meta name="viewport"[^>]*>/g, '');
const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
const artifactCss = `<style>
.top, body[data-view="home"] .top { top: env(safe-area-inset-top, 0px); padding-top: 10px; }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--bar); }
.auth-brand { padding-top: 22px; }
.menu { top: 62px; }
</style>`;
fs.writeFileSync(path.join(root, 'dist', 'oddsday-artifact.html'), head.trim() + '\n' + artifactCss + '\n' + body.trim() + '\n');
console.log('dist/oddsday-artifact.html written');
