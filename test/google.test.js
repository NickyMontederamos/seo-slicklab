'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeServiceAccount, startMockGoogle, place } = require('./mock-google.js');
const { clearTokenCache, signJwt, loadKey } = require('../mcp/lib/google-auth.js');
const gsc = require('../mcp/lib/gsc.js');
const places = require('../mcp/lib/places.js');

const TODAY = new Date('2026-10-09T00:00:00Z');
const P = gsc.periods(28, TODAY);
const rowsFor = (body) => (body.startDate === P.current.start
  ? [{ keys: ['software company cebu'], clicks: 12, impressions: 300, ctr: 0.04, position: 6.2 },
     { keys: ['slickcaption'], clicks: 30, impressions: 90, ctr: 0.33, position: 1.1 },
     { keys: ['live caption app philippines'], clicks: 2, impressions: 80, ctr: 0.025, position: 9.0 }]
  : [{ keys: ['software company cebu'], clicks: 5, impressions: 200, ctr: 0.025, position: 11.4 },
     { keys: ['slickcaption'], clicks: 28, impressions: 85, ctr: 0.33, position: 1.0 }]);

let sa, mock;
test.before(async () => {
  sa = makeServiceAccount();
  mock = await startMockGoogle({
    publicKey: sa.publicKey, searchRows: rowsFor,
    places: [place('Symph', 50, 5, 'https://symph.example/'), place('SlickLab.Digital', 3, 5, 'https://slicklab.digital/'),
      place('Arcanys', 29, 4.6, 'https://arcanys.example/'), place('Lanex', 38, 4.9, null)]
  });
  process.env.GOOGLE_API_ROOT = mock.base;
  process.env.GOOGLE_TOKEN_URL = `${mock.base}/token`;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = sa.file;
  process.env.PLACES_API_BASE = mock.base;
  process.env.PLACES_API_KEY = 'test-places-key';
});
test.after(() => mock.close());
test.beforeEach(() => clearTokenCache());

test('property names', () => {
  assert.equal(gsc.propertyFor('slicklab.digital'), 'sc-domain:slicklab.digital');
  assert.equal(gsc.propertyFor('www.slicklab.digital'), 'sc-domain:slicklab.digital');
  assert.equal(gsc.propertyFor('https://slicklab.digital'), 'https://slicklab.digital/');
  assert.equal(gsc.propertyFor('sc-domain:x.com'), 'sc-domain:x.com');
});

test('periods account for the Search Console data lag', () => {
  assert.deepEqual(P, { current: { start: '2026-09-09', end: '2026-10-06' }, previous: { start: '2026-08-12', end: '2026-09-08' } });
});

test('JWT is signed with the service-account key (mock verifies the signature)', async () => {
  const jwt = signJwt(loadKey(sa.file), gsc.SCOPE, 1000);
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  assert.equal(claims.iss, sa.email);
  assert.equal(claims.exp, 4600);
  await gsc.performance('exampleco.test', { today: TODAY });
  await gsc.performance('exampleco.test', { today: TODAY });
  assert.equal(mock.seen.tokens, 1, 'token is cached between calls');
});

test('performance compares periods; position_change < 0 means moved up', async () => {
  const r = await gsc.performance('exampleco.test', { today: TODAY });
  const sw = r.rows.find((x) => x.key === 'software company cebu');
  assert.equal(sw.position_change, -5.2);
  assert.equal(sw.clicks_change, 7);
  assert.equal(r.rows.find((x) => x.key === 'live caption app philippines').new, true);
  assert.deepEqual(r.totals, { clicks: 44, impressions: 470, previous_clicks: 33 });
  const md = gsc.formatPerformance(r);
  assert.match(md, /\| software company cebu \| 12 \(\+7\) \| 300 \| 4\.0% \| 6\.2 \(▲ 5\.2\) \|/);
});

test('helpful errors: missing permission and missing key', async () => {
  await assert.rejects(gsc.performance('other.test', { today: TODAY }), /add the service account email as a user/);
  const saved = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  clearTokenCache(); // the key file is only read when a new token is needed
  try { await assert.rejects(gsc.performance('exampleco.test', { today: TODAY }), /GOOGLE_APPLICATION_CREDENTIALS is not set/); }
  finally { process.env.GOOGLE_APPLICATION_CREDENTIALS = saved; }
});

test('URL inspection and sitemaps', async () => {
  const ok = await gsc.inspectUrl('exampleco.test', 'https://exampleco.test/');
  assert.equal(ok.verdict, 'PASS');
  const fresh = await gsc.inspectUrl('exampleco.test', 'https://exampleco.test/new');
  assert.equal(fresh.coverage, 'Discovered - currently not indexed');
  const sm = await gsc.sitemaps('exampleco.test');
  assert.deepEqual(sm, [{ path: 'https://exampleco.test/sitemap.xml', last_downloaded: '2026-10-01T00:00:00Z', errors: 0, warnings: 1, submitted: 12 }]);
});

test('Places: finds you by website, reports position and review gap', async () => {
  const r = await places.localPackCheck({ query: 'software company Cebu City', business_name: 'SlickLab', website: 'slicklab.digital', lat: 10.3157, lng: 123.8854 });
  assert.equal(mock.seen.placesHeaders['x-goog-fieldmask'].includes('places.userRatingCount'), true);
  assert.deepEqual(mock.seen.placesBody.locationBias.circle.center, { latitude: 10.3157, longitude: 123.8854 });
  assert.equal(r.found, true);
  assert.equal(r.position, 2);
  assert.equal(r.review_median, 38);
  assert.equal(r.without_website, 1);
  const md = places.formatLocalPack(r, 'SlickLab');
  assert.match(md, /SlickLab is #2 of 4/);
  assert.match(md, /about 35 more genuine reviews/);
});

test('Places: not found, name matching, bad key', async () => {
  const r = await places.localPackCheck({ query: 'software company Cebu City', business_name: 'Nobody Software' });
  assert.equal(r.found, false);
  assert.match(places.formatLocalPack(r, 'Nobody Software'), /not in the top 4/);
  assert.equal(places.isYou({ displayName: { text: 'Symph- Software Development' } }, { business_name: 'Symph' }), true);
  assert.equal(places.isYou({ displayName: { text: 'Symphony Labs' } }, { business_name: 'Symph' }), false);
  process.env.PLACES_API_KEY = 'wrong';
  try { await assert.rejects(places.localPackCheck({ query: 'x', business_name: 'y' }), /API key not valid/); }
  finally { process.env.PLACES_API_KEY = 'test-places-key'; }
});
