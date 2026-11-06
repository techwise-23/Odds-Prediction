// Builds dist/admin-preview.html: the admin console in one file, running on sample data with no server.
// Usage: node build/build-preview.js   (inside admin/)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const backend = path.join(root, '..', 'backend', 'src');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const readBackend = f => fs.readFileSync(path.join(backend, f), 'utf8');
const config = require(path.join(backend, 'config'));
const wrap = (src, name) => `const ${name} = (() => { const module = { exports: {} }; ${src}\n; return module.exports; })();`;
const shared = { tiers: config.tiers, accas: config.accas, leagues: config.leagues, platforms: config.platforms.map(({ key, name, url }) => ({ key, name, url })) };

const script = [
  `const CONFIG = ${JSON.stringify(shared)};`,
  wrap(readBackend('model.js'), 'Model'), wrap(readBackend('phone.js'), 'Phone'), wrap(readBackend('demo.js'), 'makeDemo'),
  fs.readFileSync(path.join(root, '..', 'frontend', 'build', 'local-api.js'), 'utf8'),
  read('build/preview-api.js'),
  read('src/admin.js'),
].join('\n\n').replace(/<\/script/gi, '<\\/script');

let html = read('src/index.html')
  .replace('<link rel="stylesheet" href="base.css">', () => `<style>\n${read('src/base.css')}\n</style>`)
  .replace('<link rel="stylesheet" href="admin.css">', () => `<style>\n${read('src/admin.css')}\n</style>`)
  .replace('<script src="config.js"></script>\n  <script src="admin.js"></script>', () => `<script>\n${script}\n</script>`)
  .replace(/<meta name="robots"[^>]*>\n?/, '');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'admin-preview.html'), html);
console.log(`dist/admin-preview.html written (${(html.length / 1024).toFixed(0)} KB)`);
