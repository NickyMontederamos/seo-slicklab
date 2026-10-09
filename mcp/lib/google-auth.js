'use strict';

/**
 * Google service-account auth with Node's built-in crypto (no googleapis dependency).
 * Reads the JSON key from GOOGLE_APPLICATION_CREDENTIALS (a file path), signs a JWT
 * (RS256) and exchanges it for an access token, cached until shortly before expiry.
 */

const crypto = require('crypto');
const fs = require('fs');

const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const cache = new Map(); // scope -> { token, exp }

function loadKey(path = process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  if (!path) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set (path to the service-account JSON key).');
  let key;
  try { key = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`Could not read service-account key at ${path}: ${e.message}`); }
  if (!key.client_email || !key.private_key) throw new Error(`${path} is not a service-account key (missing client_email / private_key).`);
  return key;
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function signJwt(key, scope, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email, scope, aud: TOKEN_URL(), iat: now, exp: now + 3600
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key);
  return `${header}.${claims}.${b64url(sig)}`;
}

const inflight = new Map(); // scope -> pending token request, so parallel callers share one

async function getAccessToken(scope, key) {
  const hit = cache.get(scope);
  if (hit && hit.exp - 60 > Date.now() / 1000) return hit.token;
  if (inflight.has(scope)) return inflight.get(scope);
  const req = requestToken(scope, key || loadKey()).finally(() => inflight.delete(scope));
  inflight.set(scope, req);
  return req;
}

async function requestToken(scope, key) {
  const res = await fetch(TOKEN_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signJwt(key, scope)
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token request failed (HTTP ${res.status}): ${body.error_description || body.error || 'no token returned'}`);
  }
  cache.set(scope, { token: body.access_token, exp: Date.now() / 1000 + (body.expires_in || 3600) });
  return body.access_token;
}

function clearTokenCache() { cache.clear(); inflight.clear(); }

module.exports = { loadKey, signJwt, getAccessToken, clearTokenCache };
