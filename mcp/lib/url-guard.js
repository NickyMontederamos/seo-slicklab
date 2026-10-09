'use strict';

/**
 * Refuse URLs that point at private networks. The MCP tools fetch whatever URL
 * an agent passes in, and a crawled page could steer an agent toward an
 * internal address. Set SLICKLAB_ALLOW_PRIVATE=1 to audit local dev servers.
 * Redirects are followed by the engine and are not re-checked here.
 */

const dns = require('dns').promises;
const net = require('net');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function assertPublicUrl(input) {
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`); }
  catch { throw new Error(`Invalid URL: ${input}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`Only http(s) URLs are allowed: ${input}`);
  if (process.env.SLICKLAB_ALLOW_PRIVATE === '1') return u.href;

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error(`Refusing private host: ${host}`);
  }
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error(`Refusing private address for ${host}`);
  return u.href;
}

module.exports = { isPrivateIp, assertPublicUrl };
