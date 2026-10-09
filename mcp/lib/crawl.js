'use strict';

/**
 * Whole-site crawl: find pages from sitemap.xml (or homepage links), obey robots.txt,
 * audit each page politely, then report site-level problems (duplicate titles and
 * descriptions, missing H1s, error pages, noindex pages listed in the sitemap,
 * risk flags) plus the weakest pages.
 */

const engine = require('../../seo-slicklab.js');
const { clean } = require('./untrusted.js');
const { formatRisk } = require('./risk-format.js');

const UA_TOKEN = 'seo-slicklab';
const MAX_SITEMAP_FILES = 10;

/* ---- robots.txt matching (longest match wins; Allow wins ties; * and $ wildcards) ---- */

function ruleRegex(path) {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path)
    .split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

function robotsAllows(parsed, url) {
  if (!parsed) return true;
  const ours = parsed.groups.filter((g) => g.agents.includes(UA_TOKEN));
  const groups = ours.length ? ours : parsed.groups.filter((g) => g.agents.includes('*'));
  let path;
  try { const u = new URL(url); path = u.pathname + u.search; } catch { return false; }
  let best = null;
  for (const r of groups.flatMap((g) => g.rules)) {
    if (r.type === 'disallow' && r.path === '') continue; // "Disallow:" (empty) allows everything
    if (!ruleRegex(r.path).test(path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.type === 'allow')) best = { len, type: r.type };
  }
  return !best || best.type === 'allow';
}

/* ---- URL discovery ---- */

function locs(xml) {
  const out = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) out.push(m[1].replace(/&amp;/g, '&'));
  return out;
}

async function discover(startUrl, maxPages, opts) {
  const start = new URL(startUrl);
  const origin = start.origin;
  const notes = [];

  const robotsRes = await engine.fetchText(`${origin}/robots.txt`, opts);
  const robots = engine.isTextFile(robotsRes) ? engine.parseRobotsTxt(robotsRes.text) : null;
  if (!robots) notes.push('No robots.txt found; crawling everything reachable.');

  const sitemapQueue = robots && robots.sitemaps.length ? [...robots.sitemaps] : [`${origin}/sitemap.xml`];
  const seenSitemaps = new Set();
  const fromSitemap = [];
  while (sitemapQueue.length && seenSitemaps.size < MAX_SITEMAP_FILES && fromSitemap.length < maxPages * 4) {
    const sm = sitemapQueue.shift();
    if (seenSitemaps.has(sm)) continue;
    seenSitemaps.add(sm);
    if (/\.gz($|\?)/i.test(sm)) { notes.push(`Skipped compressed sitemap ${sm}.`); continue; }
    const res = await engine.fetchText(sm, opts);
    if (res.status !== 200 || !/<(urlset|sitemapindex)\b/i.test(res.text)) continue;
    const found = locs(res.text);
    if (/<sitemapindex\b/i.test(res.text)) sitemapQueue.push(...found);
    else fromSitemap.push(...found);
  }

  let source = 'sitemap';
  let candidates = fromSitemap;
  if (!candidates.length) {
    source = 'homepage links';
    notes.push('No usable sitemap.xml; used links on the start page instead.');
    const home = await engine.fetchText(startUrl, opts);
    const doc = engine.extractDocument(home.text, startUrl, 'raw');
    candidates = doc.links.filter((l) => l.internal && !l.isAnchor && l.resolved).map((l) => l.resolved.split('#')[0]);
  }

  const urls = [];
  const seen = new Set();
  let blocked = 0, offsite = 0;
  for (const u of [start.href, ...candidates]) {
    let abs;
    try { abs = new URL(u, origin); } catch { continue; }
    abs.hash = '';
    if (abs.origin !== origin) { offsite++; continue; }
    if (seen.has(abs.href)) continue;
    seen.add(abs.href);
    if (!robotsAllows(robots, abs.href)) { blocked++; continue; }
    urls.push(abs.href);
  }
  if (blocked) notes.push(`${blocked} URL(s) skipped because robots.txt disallows them.`);
  if (offsite) notes.push(`${offsite} sitemap URL(s) on another host were ignored.`);
  return { urls: urls.slice(0, maxPages), total_found: urls.length, source, sitemap_urls: new Set(fromSitemap), notes, robots };
}

/* ---- Crawl + aggregate ---- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function crawlSite(startUrl, { maxPages = 25, headless = false, concurrency = 2, delayMs = 500, timeout = 30000 } = {}) {
  const opts = engine.defaultOptions({ timeout, quiet: true });
  const found = await discover(engine.normalizeUrl(startUrl), maxPages, opts);

  const pages = new Array(found.urls.length);
  let next = 0;
  const worker = async () => {
    while (next < found.urls.length) {
      const i = next++;
      const url = found.urls[i];
      try {
        const a = await engine.runAudit(url, engine.defaultOptions({
          headless, quiet: true, timeout,
          llms: i === 0, riskCrawlers: i === 0 // site-wide checks once, on the first page
        }));
        pages[i] = { url, ok: true, status: a.http_status, score: a.overall_score, page: a.page, risk: a.risk, final_url: a.final_url };
      } catch (e) {
        pages[i] = { url, ok: false, status: 0, error: e.message };
      }
      if (delayMs) await sleep(delayMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, found.urls.length) }, worker));
  return { start_url: startUrl, crawled_at: new Date().toISOString(), discovery: { ...found, sitemap_urls: undefined, robots: undefined }, pages, issues: siteIssues(pages, found.sitemap_urls) };
}

function siteIssues(pages, sitemapUrls) {
  const good = pages.filter((p) => p.ok && p.status < 400);
  const groupBy = (key) => {
    const m = new Map();
    for (const p of good) {
      const v = (p.page[key] || '').trim().toLowerCase();
      if (!v) continue;
      if (!m.has(v)) m.set(v, []);
      m.get(v).push(p.url);
    }
    return [...m.entries()].filter(([, urls]) => urls.length > 1).map(([value, urls]) => ({ value, urls }));
  };
  return {
    errors: pages.filter((p) => !p.ok || p.status >= 400).map((p) => ({ url: p.url, status: p.status, error: p.error || null })),
    duplicate_titles: groupBy('title'),
    duplicate_descriptions: groupBy('meta_description'),
    missing_title: good.filter((p) => !p.page.title).map((p) => p.url),
    missing_description: good.filter((p) => !p.page.meta_description).map((p) => p.url),
    h1_problems: good.filter((p) => p.page.h1.length !== 1).map((p) => ({ url: p.url, h1_count: p.page.h1.length })),
    noindex_in_sitemap: good.filter((p) => /noindex/.test(p.page.meta_robots) && sitemapUrls.has(p.url)).map((p) => p.url),
    thin_pages: good.filter((p) => p.page.word_count < 150).map((p) => ({ url: p.url, words: p.page.word_count })),
    risky_pages: good.filter((p) => p.risk && p.risk.status !== 'clean').map((p) => ({ url: p.url, status: p.risk.status, flags: p.risk.flags.length })),
    weakest: [...good].sort((a, b) => a.score - b.score).slice(0, 5).map((p) => ({ url: p.url, score: p.score }))
  };
}

const pathOf = (u) => { try { const x = new URL(u); return clean(x.pathname + x.search, 90) || '/'; } catch { return clean(u, 90); } };

function formatCrawl(r, limit = 10) {
  const I = r.issues;
  const ok = r.pages.filter((p) => p.ok && p.status < 400);
  const avg = ok.length ? Math.round(ok.reduce((a, p) => a + p.score, 0) / ok.length) : 0;
  const L = [];
  L.push(`# Site crawl — ${clean(r.start_url)}`);
  L.push('');
  L.push(`Crawled ${r.pages.length} of ${r.discovery.total_found} page(s) found via ${r.discovery.source}. Average page score ${avg}/100.`);
  for (const n of r.discovery.notes) L.push(`- ${clean(n, 200)}`);
  L.push('');

  const list = (title, items, fmt) => {
    if (!items.length) return;
    L.push(`## ${title} (${items.length})`);
    items.slice(0, limit).forEach((x) => L.push(`- ${fmt(x)}`));
    if (items.length > limit) L.push(`- …and ${items.length - limit} more`);
    L.push('');
  };
  list('Pages with risk flags', I.risky_pages, (x) => `${pathOf(x.url)} — ${x.status.toUpperCase()}, ${x.flags} flag(s)`);
  list('Error pages', I.errors, (x) => `${pathOf(x.url)} — ${x.status ? `HTTP ${x.status}` : clean(x.error, 120)}`);
  list('noindex pages listed in the sitemap', I.noindex_in_sitemap, pathOf);
  list('Duplicate titles', I.duplicate_titles, (x) => `"${clean(x.value, 80)}" on ${x.urls.map(pathOf).join(', ')}`);
  list('Duplicate meta descriptions', I.duplicate_descriptions, (x) => `"${clean(x.value, 80)}" on ${x.urls.map(pathOf).join(', ')}`);
  list('Missing title', I.missing_title, pathOf);
  list('Missing meta description', I.missing_description, pathOf);
  list('Not exactly one H1', I.h1_problems, (x) => `${pathOf(x.url)} — ${x.h1_count} H1s`);
  list('Thin pages (<150 words)', I.thin_pages, (x) => `${pathOf(x.url)} — ${x.words} words`);
  list('Weakest pages', I.weakest, (x) => `${pathOf(x.url)} — ${x.score}/100`);

  const flagged = r.pages.filter((p) => p.ok && p.risk && p.risk.flags.length).slice(0, 3);
  for (const p of flagged) {
    L.push(...formatRisk(p.risk, { title: `Risk detail — ${pathOf(p.url)}` }));
    L.push('');
  }
  L.push('_Cloaking and crawler-access checks run on the first page only, to keep the crawl light on the server._');
  return L.join('\n');
}

module.exports = { robotsAllows, ruleRegex, locs, discover, crawlSite, siteIssues, formatCrawl };
