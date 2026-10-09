'use strict';

/**
 * Local filtering proxy for the headless browser in public mode.
 *
 * Playwright's request routing does not see redirects the browser follows on its
 * own, so a public image that redirects to an internal address would slip through.
 * Sending all browser traffic through this proxy checks every request — redirect
 * hops included — and connects to the exact IP that passed the check.
 */

const http = require('http');
const net = require('net');
const { resolvePublic } = require('../mcp/lib/url-guard.js');

const HOP_HEADERS = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade'];

function splitHostPort(authority) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(authority) || /^([^:]+):(\d+)$/.exec(authority);
  return m ? [m[1], Number(m[2])] : [authority, 443];
}

function startGuardProxy() {
  const server = http.createServer(async (req, res) => {
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
    let ip;
    try { ip = await resolvePublic(target.href); }
    catch { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('Blocked: private address'); }
    const headers = { ...req.headers, host: target.host };
    for (const h of HOP_HEADERS) delete headers[h];
    const upstream = http.request({
      host: ip, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers
    }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });

  server.on('connect', async (req, client, head) => {
    const [host, port] = splitHostPort(req.url);
    client.on('error', () => {});
    let ip;
    try { ip = await resolvePublic(`https://${net.isIPv6(host) ? `[${host}]` : host}:${port}/`); }
    catch { return client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
    const upstream = net.connect(port, ip, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(() => r()))
  })));
}

module.exports = { startGuardProxy };
