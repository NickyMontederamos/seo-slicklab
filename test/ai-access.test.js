'use strict';

process.env.SLICKLAB_ALLOW_PRIVATE = '1';
const test = require('node:test');
const assert = require('node:assert');
const { checkAiAccess, looksLikeHtml } = require('../mcp/lib/ai-access.js');
const { startSite, SPA_SITE, STRONG_SITE, PLAIN_SITE } = require('./fixtures.js');

test('flags JS shell, blocked GPTBot, fake llms.txt, missing schema', async () => {
  const site = await startSite(SPA_SITE);
  try {
    const r = await checkAiAccess(site.url);
    assert.equal(r.raw_html.looks_like_js_shell, true);
    assert.equal(r.llms_txt.present, false, 'catch-all HTML must not count as llms.txt');
    assert.deepEqual(r.crawlers.filter((c) => c.blocked).map((c) => c.bot), ['GPTBot']);
    const titles = r.findings.map((f) => f.title);
    assert.ok(titles.includes('Content only appears after JavaScript runs'));
    assert.ok(titles.includes('No schema.org structured data in raw HTML'));
    assert.ok(titles.some((t) => t.startsWith('robots.txt blocks 1 crawler')));
    assert.equal(r.findings.find((f) => f.title.startsWith('robots.txt blocks')).impact, 'medium',
      'blocking only a training crawler is medium, not high');
  } finally { site.close(); }
});

test('strong site passes the AI checks', async () => {
  const site = await startSite(STRONG_SITE);
  try {
    const r = await checkAiAccess(site.url);
    assert.equal(r.llms_txt.present, true);
    assert.equal(r.raw_html.looks_like_js_shell, false);
    assert.deepEqual(r.raw_html.json_ld_types, ['Organization']);
    assert.equal(r.crawlers.some((c) => c.blocked), false);
    assert.equal(r.findings.length, 0, JSON.stringify(r.findings));
  } finally { site.close(); }
});

test('missing robots.txt is reported, not treated as blocking', async () => {
  const site = await startSite(PLAIN_SITE);
  try {
    const r = await checkAiAccess(site.url);
    assert.equal(r.robots_txt.valid, false);
    assert.equal(r.crawlers.some((c) => c.blocked), false);
    assert.ok(r.findings.some((f) => f.title === 'No valid robots.txt'));
  } finally { site.close(); }
});

test('looksLikeHtml detects HTML served as a text file', () => {
  assert.equal(looksLikeHtml({ contentType: 'text/plain', text: '<!DOCTYPE html><html>' }), true);
  assert.equal(looksLikeHtml({ contentType: 'text/plain', text: '# Title' }), false);
});
