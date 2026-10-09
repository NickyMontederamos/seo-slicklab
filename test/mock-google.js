'use strict';

/**
 * Local stand-in for Google's token, Search Console and Places endpoints.
 * Verifies the service-account JWT signature with the matching public key.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function makeServiceAccount() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = {
    type: 'service_account', client_email: 'bot@test-project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-')), 'sa.key.json');
  fs.writeFileSync(file, JSON.stringify(key));
  return { file, publicKey, email: key.client_email };
}

const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b));
});

/**
 * @param {object} o
 * @param {crypto.KeyObject} o.publicKey
 * @param {(body)=>Array} o.searchRows   rows for a searchAnalytics request body
 * @param {Array} o.places               Places API result list
 */
function startMockGoogle({ publicKey, searchRows = () => [], places = [] }) {
  const seen = { tokens: 0, placesHeaders: null, placesBody: null, webhook: [] };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const authed = () => req.headers.authorization === 'Bearer mock-token';

    if (req.url === '/token' && req.method === 'POST') {
      const assertion = new URLSearchParams(body).get('assertion') || '';
      const [h, c, sig] = assertion.split('.');
      const ok = h && c && sig && crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url'));
      const claims = ok ? JSON.parse(Buffer.from(c, 'base64url').toString()) : {};
      if (!ok || !/webmasters\.readonly/.test(claims.scope || '')) return send(401, { error: 'invalid_grant', error_description: 'bad signature or scope' });
      seen.tokens++;
      return send(200, { access_token: 'mock-token', expires_in: 3600 });
    }
    if (/^\/webmasters\/v3\/sites\/[^/]+\/searchAnalytics\/query$/.test(req.url)) {
      if (!authed()) return send(401, { error: { message: 'unauthenticated' } });
      if (!req.url.includes(encodeURIComponent('sc-domain:exampleco.test'))) return send(403, { error: { message: 'User does not have sufficient permission' } });
      return send(200, { rows: searchRows(JSON.parse(body)) });
    }
    if (/^\/webmasters\/v3\/sites\/[^/]+\/sitemaps$/.test(req.url)) {
      if (!authed()) return send(401, { error: { message: 'unauthenticated' } });
      return send(200, { sitemap: [{ path: 'https://exampleco.test/sitemap.xml', lastDownloaded: '2026-10-01T00:00:00Z', errors: '0', warnings: '1', contents: [{ submitted: '12' }] }] });
    }
    if (req.url === '/searchconsole/v1/urlInspection/index:inspect') {
      if (!authed()) return send(401, { error: { message: 'unauthenticated' } });
      const { inspectionUrl } = JSON.parse(body);
      return send(200, { inspectionResult: { indexStatusResult: {
        verdict: inspectionUrl.endsWith('/new') ? 'NEUTRAL' : 'PASS',
        coverageState: inspectionUrl.endsWith('/new') ? 'Discovered - currently not indexed' : 'Submitted and indexed',
        lastCrawlTime: '2026-10-05T03:00:00Z', googleCanonical: inspectionUrl, userCanonical: inspectionUrl,
        robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED', pageFetchState: 'SUCCESSFUL'
      } } });
    }
    if (req.url === '/v1/places:searchText' && req.method === 'POST') {
      seen.placesHeaders = req.headers; seen.placesBody = JSON.parse(body);
      if (req.headers['x-goog-api-key'] !== 'test-places-key') return send(403, { error: { message: 'API key not valid' } });
      return send(200, { places: api.placesList });
    }
    if (req.url === '/webhook' && req.method === 'POST') { seen.webhook.push(JSON.parse(body)); return send(200, { ok: true }); }
    send(404, { error: { message: `no mock for ${req.method} ${req.url}` } });
  });
  const api = { seen, placesList: [...places], close: () => server.close() };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    api.base = `http://127.0.0.1:${server.address().port}`;
    resolve(api);
  }));
}

const place = (name, reviews, rating, website) => ({
  displayName: { text: name }, userRatingCount: reviews, rating, websiteUri: website,
  formattedAddress: 'Cebu City', googleMapsUri: 'https://maps.example/x', businessStatus: 'OPERATIONAL'
});

module.exports = { makeServiceAccount, startMockGoogle, place };
