'use strict';
// Run: node --test 'tests/*.test.js'   (needs the engine's own dependency, cheerio)
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ENGINE = path.join(__dirname, '..', 'seo-slicklab.js');
const hasCheerio = (() => { try { require.resolve('cheerio'); return true; } catch { return false; } })();

function runEngine(url, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath,
      [ENGINE, url, '--format', 'json', '--quiet', '--no-headless', '--no-llms', '--no-social', '--timeout', '5000'],
      { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('engine refuses private targets in public mode and never fetches them',
  { skip: !hasCheerio && 'cheerio not installed (npm i cheerio)' }, async () => {
    let hits = 0;
    const server = http.createServer((req, res) => { hits++; res.end('<html><title>internal</title></html>'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${server.address().port}/`;
    try {
      for (const url of [target, 'http://169.254.169.254/latest/meta-data/', 'http://localhost/']) {
        const r = await runEngine(url, { SLICKLAB_PUBLIC_MODE: '1' });
        assert.strictEqual(r.code, 3, `${url}: exit code (stderr: ${r.stderr})`);
        assert.match(r.stderr, /not allowed/, url);
        assert.strictEqual(r.stdout, '', url);
      }
      assert.strictEqual(hits, 0, 'private server must not be contacted');

      // Control: the same request without public mode does reach the server,
      // so the zero above is the guard working, not a broken test.
      const r = await runEngine(target, { SLICKLAB_PUBLIC_MODE: '' });
      assert.strictEqual(r.code, 0, r.stderr);
      assert.ok(hits > 0);
    } finally {
      server.close();
    }
  });
