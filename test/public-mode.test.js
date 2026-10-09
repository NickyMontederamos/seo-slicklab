'use strict';

/**
 * Public mode (index.php): visitors choose the URL, so nothing may reach a private
 * address. An "internal" server counts every request it gets; it must get none.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.SLICKLAB_PUBLIC_MODE = '1';
delete process.env.SLICKLAB_ALLOW_PRIVATE;
const engine = require('../seo-slicklab.js');
engine.setQuiet(true);
const HEADLESS = Boolean(process.env.SLICKLAB_CHROMIUM_PATH);

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

let internal, pub, hits = [];
test.before(async () => {
  internal = await listen((req, res) => { hits.push(req.url); res.end('SECRET metadata'); });
  const B = `http://127.0.0.1:${internal.port}`;
  pub = await listen((req, res) => {
    const A = `http://127.0.0.1:${pub.port}`;
    if (req.url === '/to-internal') { res.writeHead(302, { Location: `${B}/latest/meta-data/` }); return res.end(); }
    if (req.url === '/hop1') { res.writeHead(301, { Location: '/hop2' }); return res.end(); }
    if (req.url === '/hop2') { res.writeHead(302, { Location: '/' }); return res.end(); }
    if (req.url === '/img-redirect') { res.writeHead(302, { Location: `${B}/via-image-redirect` }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><head><title>Public page</title>
<meta property="og:image" content="${B}/og-image.png"></head>
<body><h1>Public</h1><p>${'word '.repeat(120)}</p>
<img src="${B}/img.png" alt="x"><iframe src="${B}/frame" title="f"></iframe>
<img src="${A}/img-redirect" alt="y"><script>fetch('${B}/xhr').catch(() => {})</script></body></html>`);
  });
  // Only the "public" test server is exempt; the internal one stays private.
  process.env.SLICKLAB_ALLOW_HOSTS = `127.0.0.1:${pub.port}`;
});
test.after(() => { internal.server.close(); pub.server.close(); });
test.beforeEach(() => { hits = []; });

const opts = (o = {}) => engine.defaultOptions({ quiet: true, headless: HEADLESS, ...o });

test('direct audit of a private address is refused', async () => {
  await assert.rejects(engine.runAudit(`http://127.0.0.1:${internal.port}/`, opts()), /Refusing private address/);
  await assert.rejects(engine.runAudit('http://169.254.169.254/latest/meta-data/', opts()), /Refusing private address/);
  assert.deepEqual(hits, []);
});

test('a public page that redirects inward is refused before the request', async () => {
  await assert.rejects(engine.runAudit(`http://127.0.0.1:${pub.port}/to-internal`, opts()), /Refusing private address/);
  assert.deepEqual(hits, []);
});

test('ordinary redirects on the public site still work', async () => {
  const a = await engine.runAudit(`http://127.0.0.1:${pub.port}/hop1`, opts({ headless: false }));
  assert.equal(a.final_url, `http://127.0.0.1:${pub.port}/`);
  assert.equal(a.http_status, 200);
});

test('embedded image, iframe, script fetch, og:image and image redirect never reach the internal server',
  { timeout: 120000 }, async () => {
    const a = await engine.runAudit(`http://127.0.0.1:${pub.port}/`, opts());
    assert.equal(a.http_status, 200);
    if (HEADLESS) {
      assert.equal(a.fetch_timing.headless_available, true);
      assert.equal(a.risk.checked.rendered_page_checked, true, 'page really rendered through the guard proxy');
    }
    assert.deepEqual(hits, [], `internal server was hit: ${hits.join(', ')}`);
  });

test('guard proxy: HTTPS tunnels (CONNECT) to private hosts are refused, allowed hosts pass', async () => {
  const { startGuardProxy } = require('../engines/guard-proxy.js');
  const proxy = await startGuardProxy();
  const connect = (authority) => new Promise((resolve, reject) => {
    const u = new URL(proxy.server);
    const req = http.request({ host: u.hostname, port: u.port, method: 'CONNECT', path: authority });
    req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  try {
    assert.equal(await connect(`127.0.0.1:${internal.port}`), 403);
    assert.equal(await connect('169.254.169.254:443'), 403);
    assert.equal(await connect(`127.0.0.1:${pub.port}`), 200);
    assert.deepEqual(hits, []);
  } finally { await proxy.close(); }
});
