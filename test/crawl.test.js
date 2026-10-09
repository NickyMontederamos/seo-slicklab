'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { robotsAllows, locs, crawlSite, formatCrawl } = require('../mcp/lib/crawl.js');
const { parseRobotsTxt } = require('../seo-slicklab.js');
const { startMultiPageSite } = require('./site-fixture.js');

test('robots.txt matching: longest rule wins, Allow wins ties, wildcards, our own group', () => {
  const r = parseRobotsTxt('User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\nDisallow:\n');
  const ok = (p) => robotsAllows(r, `https://x.test${p}`);
  assert.equal(ok('/'), true);
  assert.equal(ok('/private/x'), false);
  assert.equal(ok('/private/ok/y'), true);
  assert.equal(ok('/files/a.pdf'), false);
  assert.equal(ok('/files/a.pdf?v=1'), true);
  const ours = parseRobotsTxt('User-agent: *\nDisallow: /\n\nUser-agent: seo-slicklab\nAllow: /\n');
  assert.equal(robotsAllows(ours, 'https://x.test/a'), true, 'a group naming us overrides *');
  const s = parseRobotsTxt('User-agent: s\nDisallow: /\n');
  assert.equal(robotsAllows(s, 'https://x.test/a'), true, 'a group for agent "s" is not ours');
});

test('sitemap <loc> parsing handles CDATA and entities', () => {
  assert.deepEqual(locs('<loc><![CDATA[https://a.test/x]]></loc><loc> https://a.test/?a=1&amp;b=2 </loc>'),
    ['https://a.test/x', 'https://a.test/?a=1&b=2']);
});

test('crawl: sitemap index, robots.txt, site-level issues', { timeout: 120000 }, async () => {
  const site = await startMultiPageSite();
  try {
    const r = await crawlSite(site.url, { maxPages: 20, delayMs: 0 });
    const paths = r.pages.map((p) => new URL(p.url).pathname);
    assert.deepEqual(paths.sort(), ['/', '/about', '/hidden-page', '/old', '/private/ok', '/services'].sort());
    assert.equal(r.discovery.source, 'sitemap');
    assert.ok(r.discovery.notes.some((n) => /1 URL\(s\) skipped because robots.txt/.test(n)));
    assert.ok(r.discovery.notes.some((n) => /another host were ignored/.test(n)));

    const I = r.issues;
    assert.deepEqual(I.errors.map((e) => [new URL(e.url).pathname, e.status]), [['/old', 404]]);
    assert.deepEqual(I.duplicate_titles.map((d) => d.value), ['example co']);
    assert.deepEqual(I.duplicate_descriptions[0].urls.map((u) => new URL(u).pathname), ['/about', '/services']);
    assert.deepEqual(I.h1_problems.map((h) => new URL(h.url).pathname), ['/services']);
    assert.deepEqual(I.noindex_in_sitemap.map((u) => new URL(u).pathname), ['/hidden-page']);

    const md = formatCrawl(r);
    assert.match(md, /Crawled 6 of 6 page\(s\) found via sitemap/);
    assert.match(md, /## Duplicate titles \(1\)/);
  } finally { site.close(); }
});
