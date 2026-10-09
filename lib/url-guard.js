'use strict';
/**
 * SSRF guard for SEO-slicklab public mode (SLICKLAB_PUBLIC_MODE=1).
 *
 * Refuses loopback, private, link-local, CGNAT, unique-local IPv6 and other
 * reserved ranges, plus local-only hostnames. lib/url-guard.php mirrors the
 * same rules for the PHP front end; tests/fixtures/url-guard-cases.json keeps
 * the two in sync.
 */

const dns = require('dns');
const http = require('http');
const net = require('net');

const BLOCKED_IPV4 = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // CGNAT (also Alibaba Cloud metadata 100.100.100.200)
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (cloud metadata 169.254.169.254)
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // 6to4 relay anycast
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4]       // reserved + broadcast
];

const BLOCKED_IPV6 = [
  ['::', 96],            // unspecified, loopback (::1), IPv4-compatible
  ['::ffff:0:0', 96],    // IPv4-mapped
  ['64:ff9b::', 96],     // NAT64
  ['64:ff9b:1::', 48],   // local-use NAT64
  ['100::', 64],         // discard-only
  ['2001::', 32],        // Teredo
  ['2001:db8::', 32],    // documentation
  ['2002::', 16],        // 6to4 (embeds an IPv4 address)
  ['fc00::', 7],         // unique local (AWS IMDS fd00:ec2::254)
  ['fe80::', 10],        // link-local
  ['fec0::', 10],        // site-local (deprecated)
  ['ff00::', 8]          // multicast
];

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.internal', '.local', '.localdomain', '.home.arpa'];

const NOT_ALLOWED_MSG =
  'URL not allowed: it points to a private, loopback, or reserved network address. ' +
  'SEO-slicklab only audits public websites.';

class UrlNotAllowedError extends Error {
  constructor(message = NOT_ALLOWED_MSG) {
    super(message);
    this.name = 'UrlNotAllowedError';
    this.code = 'URL_NOT_ALLOWED';
  }
}

// Separate lists: a single BlockList maps IPv4 into ::ffff:0:0/96, so the
// IPv6 rules above would otherwise match every IPv4 address.
const blockV4 = new net.BlockList();
const blockV6 = new net.BlockList();
for (const [addr, prefix] of BLOCKED_IPV4) blockV4.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of BLOCKED_IPV6) blockV6.addSubnet(addr, prefix, 'ipv6');

function normalizeHost(host) {
  let h = String(host || '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/%.*$/, '');      // IPv6 zone id
  return h.replace(/\.+$/, '');   // trailing dot(s): "localhost." === "localhost"
}

/** True for any address in a blocked range. Non-IP input returns false. */
function isPrivateIp(ip) {
  const s = normalizeHost(ip);
  const family = net.isIP(s);
  if (!family) return false;
  return family === 4 ? blockV4.check(s, 'ipv4') : blockV6.check(s, 'ipv6');
}

/** Local-only names, plus single-label names that resolve via search domains. */
function isBlockedHostname(host) {
  const h = normalizeHost(host);
  if (!h) return true;
  if (net.isIP(h)) return false;
  if (h === 'localhost' || !h.includes('.')) return true;
  return BLOCKED_HOST_SUFFIXES.some((sfx) => h.endsWith(sfx));
}

/**
 * Throws UrlNotAllowedError unless every address the URL's host resolves to
 * is public. `lookup` is injectable for tests (same shape as dns.promises.lookup).
 */
async function assertPublicUrl(input, { lookup } = {}) {
  let u;
  try { u = input instanceof URL ? input : new URL(String(input)); }
  catch { throw new UrlNotAllowedError('URL not allowed: invalid URL.'); }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UrlNotAllowedError('URL not allowed: only http:// and https:// URLs can be audited.');
  }

  await resolvePublicAddress(u.hostname, { lookup });
  return u;
}

/**
 * fetch() that follows redirects itself and runs `check` on every hop, so a
 * public URL cannot 302 the engine into 169.254.169.254 or the LAN.
 */
async function guardedFetch(url, init = {}, { maxRedirects = 10, check = assertPublicUrl } = {}) {
  let current = String(url);
  for (let hop = 0; ; hop++) {
    await check(current);
    let res;
    try {
      res = await fetch(current, { ...init, redirect: 'manual' });
    } catch (e) {
      // installDnsGuard() refusals surface as fetch's TypeError cause.
      if (e && e.cause instanceof UrlNotAllowedError) throw e.cause;
      throw e;
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    if (hop >= maxRedirects) throw new Error(`Too many redirects (>${maxRedirects})`);
    if (res.body) await res.body.cancel().catch(() => {});
    current = new URL(location, current).href;
  }
}

/**
 * Wraps a dns.lookup-style function so any answer containing a blocked
 * address fails. Checked at connect time, this also stops DNS rebinding
 * (a host that resolves public for the pre-check, private for the fetch).
 */
function wrapLookup(origLookup) {
  return function guardedLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    else if (typeof options === 'number') options = { family: options };
    if (isBlockedHostname(hostname)) {
      process.nextTick(callback, new UrlNotAllowedError());
      return {};
    }
    return origLookup.call(dns, hostname, options, (err, address, family) => {
      if (err) return callback(err);
      const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
      if (list.some(isPrivateIp)) return callback(new UrlNotAllowedError());
      return callback(null, address, family);
    });
  };
}

let dnsGuardInstalled = false;
/** Patch dns.lookup process-wide (public mode only). net/fetch read it lazily. */
function installDnsGuard() {
  if (dnsGuardInstalled) return;
  dnsGuardInstalled = true;
  dns.lookup = wrapLookup(dns.lookup);
}

/** Cached per-host checker for browser requests. data:/blob:/about: never hit the network. */
function createUrlChecker(check = assertPublicUrl) {
  const cache = new Map();
  return async function isAllowed(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return false; }
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
    if (!/^(https?|wss?):$/.test(u.protocol)) return false;
    const key = u.host;
    if (!cache.has(key)) {
      cache.set(key, check(`http://${u.host}/`).then(() => true, () => false));
    }
    return cache.get(key);
  };
}

/** Resolve `host` to one public address to connect to, or throw UrlNotAllowedError. */
async function resolvePublicAddress(host, { lookup = dns.promises.lookup } = {}) {
  const h = normalizeHost(host);
  const family = net.isIP(h);
  if (family) {
    if (isPrivateIp(h)) throw new UrlNotAllowedError();
    return { address: h, family };
  }
  if (isBlockedHostname(h)) throw new UrlNotAllowedError();
  let addrs;
  try { addrs = await lookup(h, { all: true, verbatim: true }); }
  catch { throw new UrlNotAllowedError(`URL not allowed: could not resolve host "${h}".`); }
  if (!addrs || !addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new UrlNotAllowedError();
  return addrs[0];
}

/**
 * Local forward proxy for Chromium in public mode. Every browser connection,
 * including redirect hops, iframes and WebSockets, goes through here; each is
 * resolved, checked, and connected to the exact IP that passed the check, so
 * DNS rebinding cannot swap in a private address afterwards.
 * Resolves to { url, close }.
 */
function startGuardProxy({ resolve = resolvePublicAddress } = {}) {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
    if (target.protocol !== 'http:') { res.writeHead(400); return res.end(); }
    let addr;
    try { addr = await resolve(target.hostname); }
    catch (e) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end(e.message); }

    const headers = { ...req.headers, host: target.host };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const upstream = http.request({
      host: addr.address, family: addr.family, port: target.port || 80,
      method: req.method, path: target.pathname + target.search, headers, setHost: false
    }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });

  // HTTPS and WebSockets arrive as CONNECT host:port tunnels.
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    let target;
    try { target = new URL(`http://${req.url}`); }
    catch { return client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); }
    let addr;
    try { addr = await resolve(target.hostname); }
    catch { return client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }

    const upstream = net.connect({ host: addr.address, family: addr.family, port: Number(target.port) || 443 }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveStart({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => {
        for (const s of sockets) s.destroy();
        server.close(() => done());
      })
    }));
  });
}

/**
 * Abort every Playwright request (and WebSocket, if supported) to a blocked
 * host. Playwright does not route individual redirect hops; startGuardProxy()
 * covers those, and callers should still check the final page URL.
 */
async function guardBrowserContext(context, isAllowed, blocked = []) {
  await context.route('**/*', async (route) => {
    const u = route.request().url();
    if (await isAllowed(u)) return route.continue();
    blocked.push(u);
    return route.abort('blockedbyclient');
  });
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket(/.*/, async (ws) => {
      if (await isAllowed(ws.url())) ws.connectToServer();
      else { blocked.push(ws.url()); ws.close(); }
    });
  }
  return blocked;
}

module.exports = {
  BLOCKED_IPV4,
  BLOCKED_IPV6,
  BLOCKED_HOST_SUFFIXES,
  NOT_ALLOWED_MSG,
  UrlNotAllowedError,
  isPrivateIp,
  isBlockedHostname,
  assertPublicUrl,
  guardedFetch,
  wrapLookup,
  installDnsGuard,
  createUrlChecker,
  resolvePublicAddress,
  startGuardProxy,
  guardBrowserContext
};
