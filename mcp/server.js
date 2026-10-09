#!/usr/bin/env node
'use strict';

/**
 * slicklab-seo-mcp — MCP server (stdio) exposing the SEO-slicklab engine.
 *
 * Tools:
 *   audit_site       Run the 10 engines on one URL and summarise.
 *   compare_rivals   Audit your site + rival sites and report the gaps.
 *   check_ai_access  Fast crawler / llms.txt / raw-HTML check, many URLs.
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

const SERVER_VERSION = '0.1.0';
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
  L.push(`# Audit — ${a.final_url}`);
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
  L.push(`## Top ${Math.min(top, a.recommendations.length)} of ${a.recommendations.length} recommendations`);
  a.recommendations.slice(0, top).forEach((r, i) => {
    L.push(`${i + 1}. **[${r.severity}] ${r.title}** (${r.module})`);
    if (r.action_item) L.push(`   Fix: ${r.action_item}`);
  });
  if (includeFixes && a.fix_snippets?.length) {
    L.push('');
    L.push('## Ready-to-paste fixes');
    for (const f of a.fix_snippets) {
      L.push(`### ${f.target} — ${f.reason}`);
      L.push('```');
      L.push(f.snippet);
      L.push('```');
    }
  }
  return L.join('\n');
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

function createServer() {
  const server = new McpServer({ name: 'slicklab-seo-mcp', version: SERVER_VERSION });

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
