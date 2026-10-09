'use strict';
// Run: node --test 'tests/*.test.js'
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const guard = require('../lib/url-guard');
const cases = require('./fixtures/url-guard-cases.json');

/** Fake dns.promises.lookup: host -> list of IPs. */
const fakeLookup = (table) => async (host) => {
  const ips = table[host];
  if (!ips || !ips.length) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('isPrivateIp blocks every reserved range in the fixture', () => {
  for (const ip of cases.blockedIps) assert.strictEqual(guard.isPrivateIp(ip), true, ip);
});

test('isPrivateIp allows public addresses, including range edges', () => {
  for (const ip of cases.allowedIps) assert.strictEqual(guard.isPrivateIp(ip), false, ip);
});

test('isBlockedHostname', () => {
  for (const h of cases.blockedHosts) assert.strictEqual(guard.isBlockedHostname(h), true, h);
  for (const h of cases.allowedHosts) assert.strictEqual(guard.isBlockedHostname(h), false, h);
});

test('assertPublicUrl refuses private literals and local names without DNS', async () => {
  const lookup = async () => { throw new Error('lookup must not be called'); };
  for (const url of cases.urls.blocked) {
    await assert.rejects(guard.assertPublicUrl(url, { lookup }), guard.UrlNotAllowedError, url);
  }
  // Alternate IPv4 spellings normalise to 127.0.0.1 in the WHATWG parser.
  for (const url of ['http://2130706433/', 'http://0x7f.1/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/']) {
    await assert.rejects(guard.assertPublicUrl(url, { lookup }), guard.UrlNotAllowedError, url);
  }
  for (const url of cases.urls.allowed) await guard.assertPublicUrl(url, { lookup });
});

test('assertPublicUrl checks every resolved address', async () => {
  const lookup = fakeLookup({
    'good.example': ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
    'evil.example': ['127.0.0.1'],
    'mixed.example': ['8.8.8.8', '::1'],
    'meta.example': ['169.254.169.254']
  });
  await guard.assertPublicUrl('https://good.example/page', { lookup });
  for (const host of ['evil.example', 'mixed.example', 'meta.example']) {
    await assert.rejects(guard.assertPublicUrl(`https://${host}/`, { lookup }), /not allowed/, host);
  }
  await assert.rejects(guard.assertPublicUrl('https://nx.example/', { lookup }), /could not resolve/);
});

test('guardedFetch refuses a redirect into a private host before requesting it', async () => {
  let secretHits = 0;
  const secret = await listen((req, res) => { secretHits++; res.end('secret'); });
  const secretUrl = `http://127.0.0.1:${secret.address().port}/latest/meta-data/`;
  const front = await listen((req, res) => { res.writeHead(302, { Location: secretUrl }); res.end(); });
  const frontPort = front.address().port;

  // Treat only the front server as "public" so the redirect hop is the thing under test.
  const check = async (u) => {
    if (new URL(u).port !== String(frontPort)) throw new guard.UrlNotAllowedError();
  };
  try {
    await assert.rejects(
      guard.guardedFetch(`http://127.0.0.1:${frontPort}/`, {}, { check }),
      guard.UrlNotAllowedError
    );
    assert.strictEqual(secretHits, 0);
  } finally {
    front.close();
    secret.close();
  }
});

test('guardedFetch follows allowed redirects and reports the final URL', async () => {
  const srv = await listen((req, res) => {
    if (req.url === '/a') { res.writeHead(301, { Location: '/b' }); return res.end(); }
    res.end('final');
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const res = await guard.guardedFetch(`${base}/a`, {}, { check: async () => {} });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.url, `${base}/b`);
    assert.strictEqual(await res.text(), 'final');
  } finally {
    srv.close();
  }
});

test('wrapLookup rejects DNS answers that contain a private address (rebinding)', async () => {
  const fakeOrig = (answers) => (host, opts, cb) => {
    process.nextTick(() => (opts.all
      ? cb(null, answers.map((address) => ({ address, family: 4 })))
      : cb(null, answers[0], 4)));
  };
  const call = (fn, host, opts) => new Promise((resolve) => fn(host, opts, (err, addr) => resolve({ err, addr })));

  const rebinding = guard.wrapLookup(fakeOrig(['10.0.0.7']));
  assert.ok((await call(rebinding, 'public.example', {})).err instanceof guard.UrlNotAllowedError);
  assert.ok((await call(rebinding, 'public.example', { all: true })).err instanceof guard.UrlNotAllowedError);

  const ok = guard.wrapLookup(fakeOrig(['93.184.215.14']));
  assert.strictEqual((await call(ok, 'public.example', {})).addr, '93.184.215.14');
  assert.ok((await call(ok, 'localhost', {})).err instanceof guard.UrlNotAllowedError);
});

test('createUrlChecker caches per host and lets data:/blob: through', async () => {
  let calls = 0;
  const isAllowed = guard.createUrlChecker(async (u) => {
    calls++;
    if (new URL(u).hostname === '127.0.0.1') throw new guard.UrlNotAllowedError();
  });
  assert.strictEqual(await isAllowed('https://cdn.example/a.js'), true);
  assert.strictEqual(await isAllowed('https://cdn.example/b.css'), true);
  assert.strictEqual(await isAllowed('http://127.0.0.1:6379/'), false);
  assert.strictEqual(await isAllowed('ws://127.0.0.1:9222/devtools'), false);
  assert.strictEqual(await isAllowed('data:image/png;base64,AAAA'), true);
  assert.strictEqual(await isAllowed('file:///etc/passwd'), false);
  assert.strictEqual(calls, 3); // cdn.example, 127.0.0.1, 127.0.0.1:9222
});

test('guard proxy refuses private targets for plain HTTP and CONNECT tunnels', async () => {
  let secretHits = 0;
  const secret = await listen((req, res) => { secretHits++; res.end('secret'); });
  secret.on('connect', (req, sock) => { secretHits++; sock.destroy(); });
  const front = await listen((req, res) => res.end('front ok'));
  const sp = secret.address().port;
  const fp = front.address().port;

  // "front.test" stands in for a public host; everything else uses the real rules.
  const resolve = async (host) => (host === 'front.test'
    ? { address: '127.0.0.1', family: 4 }
    : guard.resolvePublicAddress(host));
  const proxy = await guard.startGuardProxy({ resolve });
  const proxyPort = Number(new URL(proxy.url).port);

  const viaProxy = (target) => new Promise((resolveRes, reject) => {
    http.get({ host: '127.0.0.1', port: proxyPort, path: target }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolveRes({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  const connectVia = (authority) => new Promise((resolveRes, reject) => {
    http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority })
      .on('connect', (res, sock) => { sock.destroy(); resolveRes(res.statusCode); })
      .on('error', reject)
      .end();
  });

  try {
    assert.deepStrictEqual(await viaProxy(`http://front.test:${fp}/`), { status: 200, body: 'front ok' });
    assert.strictEqual((await viaProxy(`http://127.0.0.1:${sp}/`)).status, 403);
    assert.strictEqual((await viaProxy(`http://localhost:${sp}/`)).status, 403);
    assert.strictEqual((await viaProxy('http://169.254.169.254/latest/meta-data/')).status, 403);
    assert.strictEqual(await connectVia(`127.0.0.1:${sp}`), 403);
    assert.strictEqual(await connectVia(`[::1]:${sp}`), 403);
    assert.strictEqual(await connectVia(`front.test:${fp}`), 200);
    assert.strictEqual(secretHits, 0);
  } finally {
    await proxy.close();
    front.close();
    secret.close();
  }
});

test('PHP guard agrees with the JS guard on the shared fixture', { skip: !hasPhp() && 'php not installed' }, () => {
  const { execFileSync } = require('node:child_process');
  execFileSync('php', [path.join(__dirname, 'url-guard.test.php')], { stdio: 'pipe' });
});

function hasPhp() {
  try { require('node:child_process').execFileSync('php', ['-v'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
