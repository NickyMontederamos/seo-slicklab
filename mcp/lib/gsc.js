'use strict';

/**
 * Google Search Console (official, free): your real queries, clicks, impressions,
 * average position, index status and sitemaps. Read-only scope.
 *
 * Property names: a bare domain ("slicklab.digital") means a Domain property
 * ("sc-domain:slicklab.digital"); a full URL means a URL-prefix property.
 */

const { getAccessToken } = require('./google-auth.js');
const { clean } = require('./untrusted.js');

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const root = () => process.env.GOOGLE_API_ROOT;
const WM = () => (root() ? `${root()}/webmasters/v3` : 'https://www.googleapis.com/webmasters/v3');
const INSPECT = () => (root() ? `${root()}/searchconsole/v1` : 'https://searchconsole.googleapis.com/v1');
const DATA_LAG_DAYS = 3; // Search Console data trails real time by ~2–3 days

function propertyFor(site) {
  const s = String(site).trim();
  if (/^sc-domain:/i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s.endsWith('/') ? s : `${s}/`;
  return `sc-domain:${s.replace(/^www\./, '').replace(/\/.*$/, '')}`;
}

async function call(method, url, body) {
  const token = await getAccessToken(SCOPE);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    const hint = res.status === 403
      ? ' — add the service account email as a user on this Search Console property.'
      : res.status === 404 ? ' — check the property name (Domain property = sc-domain:example.com).' : '';
    throw new Error(`Search Console: ${msg}${hint}`);
  }
  return data;
}

const day = (d) => d.toISOString().slice(0, 10);
function periods(days, today = new Date()) {
  const end = new Date(today); end.setUTCDate(end.getUTCDate() - DATA_LAG_DAYS);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - days + 1);
  const pEnd = new Date(start); pEnd.setUTCDate(pEnd.getUTCDate() - 1);
  const pStart = new Date(pEnd); pStart.setUTCDate(pStart.getUTCDate() - days + 1);
  return { current: { start: day(start), end: day(end) }, previous: { start: day(pStart), end: day(pEnd) } };
}

async function query(property, range, dimension, limit) {
  const data = await call('POST', `${WM()}/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
    startDate: range.start, endDate: range.end, dimensions: [dimension], rowLimit: limit, dataState: 'final'
  });
  return (data.rows || []).map((r) => ({
    key: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position
  }));
}

/** Current vs. previous period. position_change < 0 means you moved up. */
async function performance(site, { days = 28, dimension = 'query', limit = 25, today } = {}) {
  const property = propertyFor(site);
  const p = periods(days, today);
  const [cur, prev] = await Promise.all([
    query(property, p.current, dimension, limit),
    query(property, p.previous, dimension, 1000)
  ]);
  const before = new Map(prev.map((r) => [r.key, r]));
  const rows = cur.map((r) => {
    const b = before.get(r.key);
    return {
      ...r,
      clicks_change: b ? r.clicks - b.clicks : null,
      position_change: b ? Math.round((r.position - b.position) * 10) / 10 : null,
      new: !b
    };
  });
  const sum = (arr, k) => arr.reduce((a, r) => a + r[k], 0);
  return {
    property, dimension, periods: p, rows,
    totals: { clicks: sum(cur, 'clicks'), impressions: sum(cur, 'impressions'), previous_clicks: sum(prev, 'clicks') }
  };
}

async function inspectUrl(site, url) {
  const data = await call('POST', `${INSPECT()}/urlInspection/index:inspect`, { inspectionUrl: url, siteUrl: propertyFor(site) });
  const idx = data.inspectionResult?.indexStatusResult || {};
  return {
    url, verdict: idx.verdict || 'UNKNOWN', coverage: idx.coverageState || null,
    last_crawl: idx.lastCrawlTime || null, google_canonical: idx.googleCanonical || null,
    user_canonical: idx.userCanonical || null, robots_txt: idx.robotsTxtState || null,
    indexing_allowed: idx.indexingState || null, page_fetch: idx.pageFetchState || null
  };
}

async function sitemaps(site) {
  const data = await call('GET', `${WM()}/sites/${encodeURIComponent(propertyFor(site))}/sitemaps`);
  return (data.sitemap || []).map((s) => ({
    path: s.path, last_downloaded: s.lastDownloaded || null, errors: Number(s.errors || 0), warnings: Number(s.warnings || 0),
    submitted: (s.contents || []).reduce((a, c) => a + Number(c.submitted || 0), 0)
  }));
}

const sign = (n) => (n == null ? 'new' : n > 0 ? `+${n}` : String(n));

function formatPerformance(r) {
  const L = [];
  L.push(`# Search Console — ${r.property}`);
  L.push(`${r.periods.current.start} → ${r.periods.current.end}, compared with ${r.periods.previous.start} → ${r.periods.previous.end}.`);
  L.push(`Clicks ${r.totals.clicks} (previous ${r.totals.previous_clicks}) · impressions ${r.totals.impressions}`);
  L.push('');
  if (!r.rows.length) {
    L.push('_No search data yet. New or newly verified properties take a few days to fill in._');
    return L.join('\n');
  }
  const label = r.dimension === 'page' ? 'Page' : r.dimension === 'country' ? 'Country' : 'Query';
  L.push(`| ${label} | Clicks (Δ) | Impressions | CTR | Avg position (Δ) |`);
  L.push('|---|---|---|---|---|');
  for (const x of r.rows) {
    const pos = x.position_change == null ? '' : x.position_change < 0 ? ` (▲ ${-x.position_change})` : x.position_change > 0 ? ` (▼ ${x.position_change})` : ' (=)';
    L.push(`| ${clean(x.key, 80)} | ${x.clicks} (${sign(x.clicks_change)}) | ${x.impressions} | ${(x.ctr * 100).toFixed(1)}% | ${x.position.toFixed(1)}${pos} |`);
  }
  L.push('');
  L.push('_Position is Google\'s average for your pages on that query. ▲ = moved up. Search Console data trails real time by about 3 days._');
  return L.join('\n');
}

module.exports = { propertyFor, periods, performance, inspectUrl, sitemaps, formatPerformance, SCOPE };
