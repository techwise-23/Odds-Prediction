// Starts the API (:3000), public app (:5173) and admin console (:5174) together for local work.
const { spawn } = require('child_process');
const path = require('path');
const apps = [
  ['api', 'backend', 'src/server.js', {}],
  ['app', 'frontend', 'server.js', { PORT: '5173' }],
  ['admin', 'admin', 'server.js', { PORT: '5174' }],
];
const kids = apps.map(([name, dir, file, env]) => {
  const p = spawn(process.execPath, [file], { cwd: path.join(__dirname, dir), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = d => String(d).split('\n').filter(Boolean).forEach(l => console.log(`[${name}] ${l}`));
  p.stdout.on('data', tag); p.stderr.on('data', tag);
  p.on('exit', c => { console.log(`[${name}] exited (${c})`); kids.forEach(k => k.kill()); process.exit(c || 0); });
  return p;
});
process.on('SIGINT', () => kids.forEach(k => k.kill()));
