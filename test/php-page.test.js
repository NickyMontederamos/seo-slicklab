'use strict';

/**
 * The public page: renders the advisor's report safely, limits each visitor per hour, and caps
 * how many audits run at once. A stand-in engine prints a canned audit, so no network is used.
 * Skipped where PHP is not installed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const hasPhp = spawnSync('php', ['-v']).status === 0;
const ROOT = path.join(__dirname, '..');
const PUBLIC_IP_URL = 'http://93.184.215.14/'; // a public address literal: passes the guard without DNS

const AUDIT = {
  audit_id: 'test', final_url: 'https://example.com/', http_status: 200, timestamp: '2026-10-09T00:00:00Z',
  overall_score: 71, grade: 'Fair', fetch_timing: { ttfb_ms: 120, headless_available: false },
  modules: { meta_and_social: { key: 'meta_and_social', label: 'Metadata & Social Share', weight: 12, score: 80, checks: [] } },
  risk: { status: 'clean', flags: [] },
  advice: {
    summary: 'What\'s working: x. One problem to fix first.',
    headline: 'One problem to fix first, starting with: no llms.txt.',
    strengths: ['structured data is present'],
    top: [{ id: 'llms.missing', impact: 'high', effort_label: 'Under an hour', title: 'No llms.txt <script>alert(1)</script>',
      why: 'Because.', fix: 'Publish it.', fix_file: 'llms' }],
    appendix: [{ id: 'meta.alt', impact: 'low', title: 'Some images have no alt text', fix: 'Describe them.' }],
    fixes: [{ id: 'llms', file: 'llms.txt', note: 'Fill in TO CONFIRM.', content: '# Example </pre><img src=x onerror=alert(1)>' }],
    not_checked: ['Pages other than the homepage.']
  }
};

function post(port, url) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ url, run_audit: '1' }).toString();
    const req = http.request({ host: '127.0.0.1', port, path: '/index.php', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let html = ''; res.on('data', (c) => { html += c; }); res.on('end', () => resolve(html));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function startPhp(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slicklab-php-'));
  const json = path.join(dir, 'audit.json');
  fs.writeFileSync(json, JSON.stringify(AUDIT));
  const fake = path.join(dir, 'fake-node');
  fs.writeFileSync(fake, `#!/bin/sh\n${env.delay ? `sleep ${env.delay}\n` : ''}cat '${json}'\n`, { mode: 0o755 });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const php = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', ROOT], {
    stdio: 'ignore',
    env: { ...process.env, SLICKLAB_NODE: fake, SLICKLAB_LIMITS_DIR: path.join(dir, 'limits'),
      SLICKLAB_RATE_LIMIT: String(env.rate || 50), SLICKLAB_MAX_CONCURRENT: String(env.slots || 2),
      PHP_CLI_SERVER_WORKERS: '4' }
  });
  for (let i = 0; i < 50; i++) {
    try { await new Promise((ok, bad) => http.get(`http://127.0.0.1:${port}/`, (r) => { r.resume(); r.on('end', ok); }).on('error', bad)); break; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return { port, close: () => { php.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('the report shows the ranked fixes and files, and escapes everything that came from the audited site',
  { skip: !hasPhp && 'php not installed', timeout: 60000 }, async () => {
    const php = await startPhp({});
    try {
      const html = await post(php.port, PUBLIC_IP_URL);
      assert.match(html, /Fix these first/);
      assert.match(html, /One problem to fix first/);
      assert.match(html, /href="#file-llms">Get llms\.txt/);
      assert.match(html, /What this check can't see/);
      assert.doesNotMatch(html, /<script>alert\(1\)/, 'finding titles are escaped');
      assert.doesNotMatch(html, /<img src=x/, 'file contents are escaped');
      assert.match(html, /&lt;\/pre&gt;&lt;img src=x/);
      assert.match(html, /<meta name="robots" content="noindex">/, 'result pages are not indexed');
    } finally { php.close(); }
  });

test('the start page carries its own SEO: title, canonical and valid JSON-LD',
  { skip: !hasPhp && 'php not installed', timeout: 60000 }, async () => {
    const php = await startPhp({});
    try {
      const html = await new Promise((ok, bad) => http.get(`http://127.0.0.1:${php.port}/`, (r) => {
        let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => ok(b));
      }).on('error', bad));
      assert.match(html, /<title>Free SEO &amp; AI Visibility Check \| SlickLab\.Digital<\/title>/);
      assert.match(html, /<link rel="canonical" href="https:\/\/seo\.slicklab\.digital\/">/);
      const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html)[1]);
      const types = ld['@graph'].map((n) => n['@type']);
      assert.deepEqual(types, ['WebApplication', 'ProfessionalService', 'FAQPage']);
    } finally { php.close(); }
  });

test('each visitor gets a limited number of audits per hour',
  { skip: !hasPhp && 'php not installed', timeout: 60000 }, async () => {
    const php = await startPhp({ rate: 2 });
    try {
      assert.match(await post(php.port, PUBLIC_IP_URL), /Fix these first/);
      assert.match(await post(php.port, PUBLIC_IP_URL), /Fix these first/);
      const third = await post(php.port, PUBLIC_IP_URL);
      assert.match(third, /You&#039;ve run 2 checks in the last hour/);
      assert.doesNotMatch(third, /Fix these first/);
      // Refused private targets never reach the engine, so they don't use up the allowance either.
    } finally { php.close(); }
  });

test('only the configured number of audits run at once',
  { skip: !hasPhp && 'php not installed', timeout: 60000 }, async () => {
    const php = await startPhp({ slots: 1, delay: 2 });
    try {
      const [a, b] = await Promise.all([post(php.port, PUBLIC_IP_URL), post(php.port, PUBLIC_IP_URL)]);
      const busy = [a, b].filter((h) => /Other checks are running right now/.test(h)).length;
      const done = [a, b].filter((h) => /Fix these first/.test(h)).length;
      assert.equal(busy, 1);
      assert.equal(done, 1);
      assert.match(await post(php.port, PUBLIC_IP_URL), /Fix these first/, 'the slot is released afterwards');
    } finally { php.close(); }
  });
