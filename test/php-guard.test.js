'use strict';

/** index.php refuses private targets before the engine runs (skipped where PHP is not installed). */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const hasPhp = spawnSync('php', ['-v']).status === 0;

const post = (port, url) => new Promise((resolve, reject) => {
  const body = new URLSearchParams({ url, run_audit: '1' }).toString();
  const req = http.request({ host: '127.0.0.1', port, path: '/index.php', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
    let html = ''; res.on('data', (c) => { html += c; }); res.on('end', () => resolve(html));
  });
  req.on('error', reject);
  req.end(body);
});

test('index.php refuses private and metadata addresses', { skip: !hasPhp && 'php not installed', timeout: 60000 }, async () => {
  let hits = 0;
  const internal = http.createServer((req, res) => { hits++; res.end('secret'); });
  await new Promise((r) => internal.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const php = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', path.join(__dirname, '..')], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) {
      try { await post(port, 'http://localhost/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const ip = internal.address().port;
    for (const u of [`http://127.0.0.1:${ip}/`, `http://localhost:${ip}/`, `http://[::1]:${ip}/`, `http://2130706433:${ip}/`,
      'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://metadata.google.internal/']) {
      const html = await post(port, u);
      assert.match(html, /private network and cannot be audited/, u);
    }
    assert.equal(hits, 0);
  } finally { php.kill(); internal.close(); }
});
