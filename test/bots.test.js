'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runBot, renderChanges, diffRanks } = require('../bots/run.js');
const gsc = require('../mcp/lib/gsc.js');
const { clearTokenCache } = require('../mcp/lib/google-auth.js');
const { makeServiceAccount, startMockGoogle, place } = require('./mock-google.js');
const { startMultiPageSite } = require('./site-fixture.js');
const { startSite, STRONG_SITE } = require('./fixtures.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reports-'));
const at = (s) => new Date(`2026-10-${s}Z`);

let mock, sa;
const state = { rows: [] };
test.before(async () => {
  sa = makeServiceAccount();
  mock = await startMockGoogle({ publicKey: sa.publicKey, searchRows: (b) => (b.startDate === gsc.periods(28).current.start ? state.rows : []) });
  process.env.GOOGLE_API_ROOT = mock.base;
  process.env.GOOGLE_TOKEN_URL = `${mock.base}/token`;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = sa.file;
  process.env.PLACES_API_BASE = mock.base;
  process.env.PLACES_API_KEY = 'test-places-key';
  process.env.REPORT_WEBHOOK_URL = `${mock.base}/webhook`;
});
test.after(() => { mock.close(); delete process.env.REPORT_WEBHOOK_URL; });

test('first run is a baseline; later runs list what changed', () => {
  assert.match(renderChanges([], null), /First run/);
  assert.match(renderChanges([], '2026-10-01'), /Nothing notable/);
  const d = diffRanks({ rows: [{ key: 'a', position: 3 }, { key: 'n', position: 9 }] }, { rows: [{ key: 'a', position: 8 }, { key: 'gone', position: 4 }] });
  assert.deepEqual(d.map((c) => c.level), ['good', 'good', 'warn']);
});

test('watchtower: baseline, then catches a hacked page; webhook gets a summary', { timeout: 180000 }, async () => {
  const site = await startMultiPageSite();
  const dir = tmp();
  const config = { site: { name: 'Example Co', url: site.url }, crawl: { max_pages: 20 }, reports_dir: dir };
  try {
    const first = await runBot('watchtower', config, { now: at('01T06:15:00') });
    assert.deepEqual(first.changes, []);
    assert.match(fs.readFileSync(first.file, 'utf8'), /First run/);

    site.state.hackedHome = true;
    const second = await runBot('watchtower', config, { now: at('08T06:15:00') });
    assert.ok(second.changes.some((c) => c.level === 'alert' && /New risk flags on .*\/ \(high\)/.test(c.text)), JSON.stringify(second.changes));
    const md = fs.readFileSync(second.file, 'utf8');
    assert.match(md, /What changed since 2026-10-01/);
    assert.equal(second.notified, true);
    assert.match(mock.seen.webhook.at(-1).text, /SlickLab watchtower — Example Co/);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'watchtower')).sort(),
      ['2026-10-01_061500.json', '2026-10-01_061500.md', '2026-10-08_061500.json', '2026-10-08_061500.md']);
  } finally { site.close(); }
});

test('rank-tracker: detects moves, new and lost queries', { timeout: 60000 }, async () => {
  clearTokenCache();
  const dir = tmp();
  const config = { site: { name: 'Example Co', url: 'https://exampleco.test/', gsc_property: 'exampleco.test' }, reports_dir: dir };
  state.rows = [{ keys: ['software company cebu'], clicks: 3, impressions: 100, ctr: 0.03, position: 12 },
    { keys: ['old query'], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }];
  await runBot('rank-tracker', config, { now: at('01T06:00:00') });
  state.rows = [{ keys: ['software company cebu'], clicks: 9, impressions: 200, ctr: 0.045, position: 6.5 },
    { keys: ['slickcaption'], clicks: 5, impressions: 20, ctr: 0.25, position: 1.2 }];
  const r = await runBot('rank-tracker', config, { now: at('08T06:00:00') });
  const texts = r.changes.map((c) => c.text);
  assert.ok(texts.includes('"software company cebu" moved up 12.0 → 6.5'), texts.join(' | '));
  assert.ok(texts.some((t) => /New query: "slickcaption"/.test(t)));
  assert.ok(texts.some((t) => /no longer in your top list: "old query"/.test(t)));
});

test('map-check: you appearing on the map is reported', { timeout: 60000 }, async () => {
  const config = { site: { name: 'SlickLab', url: 'https://slicklab.digital/' }, local_pack: { queries: ['software company Cebu City'] }, reports_dir: tmp() };
  const others = [place('Symph', 50, 5, 'https://symph.example/'), place('Arcanys', 29, 4.6, null)];
  mock.placesList = others;
  await runBot('map-check', config, { now: at('01T07:00:00') });
  mock.placesList = [others[0], place('SlickLab.Digital', 4, 5, 'https://slicklab.digital/'), others[1]];
  const r = await runBot('map-check', config, { now: at('08T07:00:00') });
  assert.ok(r.changes.some((c) => c.text === 'You now appear for "software company Cebu City" at #2'), JSON.stringify(r.changes));
});

test('rival-scout: gap report against a stronger rival', { timeout: 180000 }, async () => {
  const [you, rival] = await Promise.all([startMultiPageSite(), startSite(STRONG_SITE)]);
  try {
    const r = await runBot('rival-scout', {
      site: { name: 'Example Co', url: you.url }, rivals: [{ label: 'Strong', url: rival.url }], reports_dir: tmp()
    }, { now: at('01T08:00:00') });
    const md = fs.readFileSync(r.file, 'utf8');
    assert.match(md, /# Rival gap report — Example Co/);
    assert.match(md, /## Where rivals beat you/);
  } finally { you.close(); rival.close(); }
});

test('clear errors for bad config', async () => {
  await assert.rejects(runBot('nope', { site: { url: 'https://x.test/' } }), /Unknown bot "nope"/);
  await assert.rejects(runBot('rival-scout', { site: { url: 'https://x.test/' }, rivals: [], reports_dir: tmp() }), /config.rivals has no URLs/);
});
