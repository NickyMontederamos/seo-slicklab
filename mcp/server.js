#!/usr/bin/env node
'use strict';

/**
 * slicklab-seo-mcp — MCP server (stdio) exposing the SEO-slicklab engine.
 *
 * Tools:
 *   audit_site       Run the 10 engines on one URL and summarise.
 *   compare_rivals   Audit your site + rival sites and report the gaps.
 *   check_ai_access  Fast crawler / llms.txt / raw-HTML check, many URLs.
 *   crawl_site       Audit every page from sitemap.xml (robots.txt respected).
 *   gsc_performance  Your real Google queries/positions from Search Console.
 *   gsc_inspect_url  Is this URL indexed? (Search Console URL Inspection)
 *   local_pack_check Where you appear in Google Maps-style results (Places API).
 *
 * Every tool is read-only: it fetches public pages and reports. Nothing is
 * posted, submitted, or changed anywhere.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const engine = require('../seo-slicklab.js');
const { buildGapReport, formatGapReport } = require('./lib/compare.js');
const { checkAiAccess, formatAiAccess } = require('./lib/ai-access.js');
const { assertPublicUrl } = require('./lib/url-guard.js');
const { clean, REDACTED, SERVER_INSTRUCTIONS } = require('./lib/untrusted.js');
const { findAiDirective } = require('../engines/risk.js');
const { crawlSite, formatCrawl } = require('./lib/crawl.js');
const gsc = require('./lib/gsc.js');
const { localPackCheck, formatLocalPack } = require('./lib/places.js');
const { formatRisk } = require('./lib/risk-format.js');

const SERVER_VERSION = '0.3.0';
const MAX_RIVALS = 8;
const AUDIT_CONCURRENCY = 2; // each audit may launch its own Chromium

engine.setQuiet(true); // engine progress goes to stderr; keep MCP logs clean

function labelFor(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** Run fn over items with at most `limit` in flight, keeping order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function auditOne(url, label, headless) {
  try {
    const safe = await assertPublicUrl(url);
    const audit = await engine.runAudit(engine.normalizeUrl(safe), engine.defaultOptions({ headless, quiet: true }));
    return { label: label || labelFor(safe), url: safe, audit };
  } catch (e) {
    return { label: label || labelFor(url), url, audit: null, error: e.message };
  }
}

function formatAuditSummary(a, top, includeFixes) {
  const L = [];
  L.push(`# Audit — ${clean(a.final_url)}`);
  L.push('');
  L.push(`Score ${a.overall_score}/100 (${a.grade}) · HTTP ${a.http_status} · TTFB ${a.fetch_timing.ttfb_ms} ms · ` +
    `JS render checked: ${a.fetch_timing.headless_available ? 'yes' : 'no'}`);
  L.push(`${a.summary.critical_errors} critical · ${a.summary.warnings} warnings · ${a.summary.notices} notices · ${a.summary.passed_checks} passed`);
  L.push('');
  L.push('| Engine | Weight | Score |');
  L.push('|---|---|---|');
  for (const m of Object.values(a.modules)) {
    if (m.key === 'scoring_reporting') continue;
    L.push(`| ${m.label} | ${m.weight}% | ${m.score} |`);
  }
  L.push('');
  L.push(...formatRisk(a.risk, { title: 'Risk flags (spam policy & AI manipulation, not scored)' }));
  L.push('');
  L.push(`## Top ${Math.min(top, a.recommendations.length)} of ${a.recommendations.length} recommendations`);
  a.recommendations.slice(0, top).forEach((r, i) => {
    L.push(`${i + 1}. **[${r.severity}] ${clean(r.title)}** (${r.module})`);
    if (r.action_item) L.push(`   Fix: ${clean(r.action_item, 300)}`);
  });
  if (includeFixes && a.fix_snippets?.length) {
    L.push('');
    L.push('## Ready-to-paste fixes');
    for (const f of a.fix_snippets) {
      L.push(`### ${clean(f.target)} — ${clean(f.reason)}`);
      L.push('```');
      L.push(safeSnippet(f.snippet));
      L.push('```');
    }
  }
  return L.join('\n');
}

/** Code stays intact for pasting; only lines addressed to AI systems are redacted, and fences can't be closed early. */
function safeSnippet(code) {
  return String(code || '').split('\n')
    .map((line) => (findAiDirective(line) ? REDACTED : line.replace(/```/g, "'''")))
    .join('\n');
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

function createServer() {
  const server = new McpServer({ name: 'slicklab-seo-mcp', version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool('audit_site', {
    title: 'Audit one site',
    description: 'Run the SEO-slicklab 10-engine audit (metadata, AI/GEO, JS rendering, DOM, links, schema, ' +
      'E-E-A-T, server/security, performance) on one public URL. Read-only. Takes 10–60 seconds.',
    inputSchema: {
      url: z.string().describe('Public page URL, e.g. https://slicklab.digital/'),
      headless: z.boolean().default(true).describe('Render with Chromium to compare raw vs JS-rendered HTML. Slower.'),
      top: z.number().int().min(1).max(50).default(10).describe('How many recommendations to list'),
      include_fixes: z.boolean().default(false).describe('Append the generated ready-to-paste fix snippets')
    }
  }, async ({ url, headless, top, include_fixes }) => {
    const r = await auditOne(url, null, headless);
    if (!r.audit) return fail(`Audit failed for ${url}: ${r.error}`);
    return text(formatAuditSummary(r.audit, top, include_fixes));
  });

  server.registerTool('compare_rivals', {
    title: 'Compare against rivals',
    description: 'Audit your site and up to 8 rival sites, then report: where rivals beat you, ' +
      'open ground no one covers yet, and where you already lead. Read-only. Roughly 30 seconds per site.',
    inputSchema: {
      your_url: z.string().describe('Your page URL'),
      your_label: z.string().optional().describe('Name to show for your site'),
      rivals: z.array(z.object({
        url: z.string(),
        label: z.string().optional()
      })).min(1).max(MAX_RIVALS).describe('Rival pages to compare, usually their homepages'),
      headless: z.boolean().default(true).describe('Render with Chromium. Turn off for a faster, raw-HTML-only comparison.'),
      limit: z.number().int().min(1).max(50).default(10).describe('Rows per section')
    }
  }, async ({ your_url, your_label, rivals, headless, limit }) => {
    const targets = [{ url: your_url, label: your_label }, ...rivals];
    const results = await mapLimit(targets, AUDIT_CONCURRENCY, (t) => auditOne(t.url, t.label, headless));
    const [you, ...others] = results;
    if (!you.audit) return fail(`Could not audit your site ${your_url}: ${you.error}`);
    const report = buildGapReport(you, others);
    return text(formatGapReport(report, limit));
  });

  server.registerTool('check_ai_access', {
    title: 'Check AI crawler access',
    description: 'Fast check of what AI crawlers see: robots.txt rules for 12 search and training crawlers, ' +
      'llms.txt, schema.org in raw HTML, and whether content needs JavaScript. No browser; a few seconds per URL.',
    inputSchema: {
      urls: z.array(z.string()).min(1).max(10).describe('Public page URLs to check')
    }
  }, async ({ urls }) => {
    const parts = await mapLimit(urls, 4, async (u) => {
      try {
        return formatAiAccess(await checkAiAccess(await assertPublicUrl(u)));
      } catch (e) {
        return `# AI access — ${u}\n\nCould not check: ${e.message}`;
      }
    });
    return text(parts.join('\n\n---\n\n'));
  });

  server.registerTool('crawl_site', {
    title: 'Crawl a whole site',
    description: 'Find pages from sitemap.xml (or homepage links), obey robots.txt, audit each page, and report ' +
      'site-wide problems: duplicate titles/descriptions, missing H1s, error pages, noindex pages in the sitemap, ' +
      'thin pages, risk flags, weakest pages. Read-only and polite (2 at a time, 0.5 s apart).',
    inputSchema: {
      url: z.string().describe('Start URL, usually the homepage'),
      max_pages: z.number().int().min(1).max(200).default(25),
      headless: z.boolean().default(false).describe('Render every page with Chromium (much slower)')
    }
  }, async ({ url, max_pages, headless }) => {
    try {
      const r = await crawlSite(await assertPublicUrl(url), { maxPages: max_pages, headless });
      return text(formatCrawl(r));
    } catch (e) { return fail(`Crawl failed: ${e.message}`); }
  });

  server.registerTool('gsc_performance', {
    title: 'Search Console performance',
    description: 'Your real Google search data from Search Console: clicks, impressions, CTR and average position ' +
      'per query (or page/country), compared with the previous period. Needs GOOGLE_APPLICATION_CREDENTIALS.',
    inputSchema: {
      site: z.string().describe('Domain ("slicklab.digital" = Domain property) or URL-prefix property URL'),
      days: z.number().int().min(7).max(90).default(28),
      dimension: z.enum(['query', 'page', 'country']).default('query'),
      limit: z.number().int().min(1).max(100).default(25)
    }
  }, async ({ site, days, dimension, limit }) => {
    try { return text(gsc.formatPerformance(await gsc.performance(site, { days, dimension, limit }))); }
    catch (e) { return fail(e.message); }
  });

  server.registerTool('gsc_inspect_url', {
    title: 'Is this URL indexed?',
    description: 'Search Console URL Inspection: index verdict, coverage, last crawl, and which canonical Google chose.',
    inputSchema: {
      site: z.string().describe('Search Console property (e.g. "slicklab.digital")'),
      url: z.string().describe('Full URL to inspect')
    }
  }, async ({ site, url }) => {
    try {
      const r = await gsc.inspectUrl(site, url);
      return text([
        `# Index status — ${clean(r.url)}`, '',
        `Verdict: **${r.verdict}** · ${clean(r.coverage || 'no coverage info')}`,
        `Last crawl: ${r.last_crawl || 'never'} · page fetch: ${r.page_fetch || '—'} · robots.txt: ${r.robots_txt || '—'}`,
        `Canonical — yours: ${clean(r.user_canonical || '—')} · Google's: ${clean(r.google_canonical || '—')}`
      ].join('\n'));
    } catch (e) { return fail(e.message); }
  });

  server.registerTool('local_pack_check', {
    title: 'Am I on the map?',
    description: 'Search Google Places (official API) the way a customer would, e.g. "software company Cebu City", and ' +
      'report whether your business appears, its position, and the review counts you are up against. Needs PLACES_API_KEY.',
    inputSchema: {
      query: z.string().describe('What a customer types, e.g. "software company Cebu City"'),
      business_name: z.string().describe('Your business name as on Google'),
      website: z.string().optional().describe('Your website, used to recognise your listing'),
      lat: z.number().optional().describe('Search centre latitude (e.g. 10.3157 for Cebu City)'),
      lng: z.number().optional().describe('Search centre longitude (e.g. 123.8854)'),
      radius_m: z.number().int().min(100).max(50000).default(5000)
    }
  }, async (p) => {
    try { return text(formatLocalPack(await localPackCheck(p), p.business_name)); }
    catch (e) { return fail(e.message); }
  });

  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`slicklab-seo-mcp ${SERVER_VERSION} (engine ${engine.VERSION}) ready on stdio`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { createServer, formatAuditSummary, mapLimit };
