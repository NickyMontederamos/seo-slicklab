#!/usr/bin/env node
'use strict';

/**
 * SlickLab bots — scheduled, read-only reporters. Run from cron on your server.
 *
 *   node bots/run.js <bot> [--config bots/config.json]
 *
 *   watchtower    weekly   crawl your site + AI access; alert on new errors, risk flags, score drops
 *   rank-tracker  weekly   Search Console queries; alert on big position moves, new/lost queries
 *   map-check     weekly   Places API map results; your position and the review gap
 *   rival-scout   monthly  your site vs rivals: gaps, open ground, rival risk flags
 *
 * Each run writes <reports_dir>/<bot>/<date>.json + .md and compares with the previous run.
 * Set REPORT_WEBHOOK_URL (Slack or Discord incoming webhook) to get a short summary posted.
 * Nothing here posts to, submits to, or changes any website.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const engine = require('../seo-slicklab.js');
const { crawlSite, formatCrawl } = require('../mcp/lib/crawl.js');
const { checkAiAccess } = require('../mcp/lib/ai-access.js');
const { buildGapReport, formatGapReport } = require('../mcp/lib/compare.js');
const gsc = require('../mcp/lib/gsc.js');
const { localPackCheck, formatLocalPack } = require('../mcp/lib/places.js');
const { clean } = require('../mcp/lib/untrusted.js');

engine.setQuiet(true);

/* ---------------------------------------------------------------------------
 * Report storage
 * -------------------------------------------------------------------------*/

function reportsDir(config) {
  return path.resolve(process.env.SLICKLAB_REPORTS_DIR || config.reports_dir || path.join(os.homedir(), 'slicklab-reports'));
}

function previousRun(dir, bot) {
  const d = path.join(dir, bot);
  if (!fs.existsSync(d)) return null;
  // Names are YYYY-MM-DD_HHMMSS, so plain string order is time order.
  const files = fs.readdirSync(d).filter((f) => /^\d{4}-\d{2}-\d{2}_\d{6}(_\d+)?\.json$/.test(f)).sort();
  if (!files.length) return null;
  try { return JSON.parse(fs.readFileSync(path.join(d, files[files.length - 1]), 'utf8')); } catch { return null; }
}

function save(dir, bot, stamp, data, md) {
  const d = path.join(dir, bot);
  fs.mkdirSync(d, { recursive: true });
  let base = stamp;
  for (let n = 2; fs.existsSync(path.join(d, `${base}.json`)); n++) base = `${stamp}_${n}`; // "_2" sorts after "."
  fs.writeFileSync(path.join(d, `${base}.json`), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(d, `${base}.md`), md);
  return path.join(d, `${base}.md`);
}

/* ---------------------------------------------------------------------------
 * Change detection (pure; compares this run's data with the last one)
 * -------------------------------------------------------------------------*/

function diffWatchtower(cur, prev) {
  const changes = [];
  if (!prev) return changes;
  const set = (arr) => new Set(arr.map((x) => (typeof x === 'string' ? x : x.url)));
  const before = { risky: set(prev.crawl.issues.risky_pages), errors: set(prev.crawl.issues.errors) };
  for (const p of cur.crawl.issues.risky_pages) if (!before.risky.has(p.url)) changes.push({ level: 'alert', text: `New risk flags on ${p.url} (${p.status})` });
  for (const p of cur.crawl.issues.errors) if (!before.errors.has(p.url)) changes.push({ level: 'alert', text: `New error page: ${p.url} (${p.status || p.error})` });
  if (cur.avg_score <= prev.avg_score - 5) changes.push({ level: 'warn', text: `Average page score dropped ${prev.avg_score} → ${cur.avg_score}` });
  if (cur.avg_score >= prev.avg_score + 5) changes.push({ level: 'good', text: `Average page score rose ${prev.avg_score} → ${cur.avg_score}` });
  const blockedNow = cur.ai.crawlers.filter((c) => c.blocked).map((c) => c.bot);
  const blockedBefore = new Set(prev.ai.crawlers.filter((c) => c.blocked).map((c) => c.bot));
  const newlyBlocked = blockedNow.filter((b) => !blockedBefore.has(b));
  if (newlyBlocked.length) changes.push({ level: 'alert', text: `robots.txt now blocks: ${newlyBlocked.join(', ')}` });
  if (prev.ai.llms_txt.present && !cur.ai.llms_txt.present) changes.push({ level: 'warn', text: 'llms.txt disappeared' });
  return changes;
}

function diffRanks(cur, prev, moveAt = 3) {
  const changes = [];
  if (!prev) return changes;
  const before = new Map(prev.rows.map((r) => [r.key, r]));
  const now = new Set(cur.rows.map((r) => r.key));
  for (const r of cur.rows) {
    const b = before.get(r.key);
    if (!b) { changes.push({ level: 'good', text: `New query: "${clean(r.key, 80)}" at position ${r.position.toFixed(1)}` }); continue; }
    const d = r.position - b.position;
    if (d <= -moveAt) changes.push({ level: 'good', text: `"${clean(r.key, 80)}" moved up ${b.position.toFixed(1)} → ${r.position.toFixed(1)}` });
    if (d >= moveAt) changes.push({ level: 'warn', text: `"${clean(r.key, 80)}" dropped ${b.position.toFixed(1)} → ${r.position.toFixed(1)}` });
  }
  for (const r of prev.rows) if (!now.has(r.key)) changes.push({ level: 'warn', text: `Query no longer in your top list: "${clean(r.key, 80)}"` });
  return changes;
}

function diffMap(cur, prev) {
  const changes = [];
  if (!prev) return changes;
  const before = new Map(prev.results.map((r) => [r.query, r]));
  for (const r of cur.results) {
    const b = before.get(r.query);
    if (!b) continue;
    if (!b.found && r.found) changes.push({ level: 'good', text: `You now appear for "${r.query}" at #${r.position}` });
    else if (b.found && !r.found) changes.push({ level: 'alert', text: `You dropped out of "${r.query}" (was #${b.position})` });
    else if (b.found && r.found && r.position !== b.position) {
      changes.push({ level: r.position < b.position ? 'good' : 'warn', text: `"${r.query}": #${b.position} → #${r.position}` });
    }
    if (r.your_listing && b.your_listing && r.your_listing.reviews !== b.your_listing.reviews) {
      changes.push({ level: 'good', text: `Your reviews: ${b.your_listing.reviews} → ${r.your_listing.reviews}` });
    }
  }
  return changes;
}

function diffRivals(cur, prev) {
  const changes = [];
  if (!prev) return changes;
  const riskBefore = new Map(prev.gap.risk.map((r) => [r.label, r.risk ? r.risk.status : null]));
  for (const r of cur.gap.risk) {
    const now = r.risk ? r.risk.status : null;
    if (r.rival && now && now !== 'clean' && riskBefore.get(r.label) === 'clean') {
      changes.push({ level: 'warn', text: `${r.label} now has risk flags (${now})` });
    }
  }
  const gapsBefore = new Set(prev.gap.gaps.map((g) => g.key));
  const closed = prev.gap.gaps.filter((g) => !cur.gap.gaps.some((x) => x.key === g.key));
  for (const g of closed) changes.push({ level: 'good', text: `Closed gap: ${g.label}` });
  for (const g of cur.gap.gaps) if (!gapsBefore.has(g.key)) changes.push({ level: 'warn', text: `New gap vs rivals: ${g.label}` });
  return changes;
}

/* ---------------------------------------------------------------------------
 * Bots
 * -------------------------------------------------------------------------*/

const BOTS = {
  async watchtower(config) {
    const crawl = await crawlSite(config.site.url, { maxPages: config.crawl?.max_pages || 50, headless: Boolean(config.crawl?.headless) });
    const ai = await checkAiAccess(config.site.url);
    const ok = crawl.pages.filter((p) => p.ok && p.status < 400);
    const avg = ok.length ? Math.round(ok.reduce((a, p) => a + p.score, 0) / ok.length) : 0;
    return {
      data: { crawl: { issues: crawl.issues, pages: crawl.pages.map(({ url, status, score, ok: k }) => ({ url, status, score, ok: k })) }, ai, avg_score: avg },
      body: formatCrawl(crawl),
      diff: diffWatchtower
    };
  },

  async 'rank-tracker'(config) {
    const property = config.site.gsc_property || config.site.url;
    const r = await gsc.performance(property, { days: config.rank_tracker?.days || 28, limit: config.rank_tracker?.limit || 50 });
    return { data: r, body: gsc.formatPerformance(r), diff: (c, p) => diffRanks(c, p, config.rank_tracker?.move_alert || 3) };
  },

  async 'map-check'(config) {
    const lp = config.local_pack || {};
    if (!lp.queries || !lp.queries.length) throw new Error('config.local_pack.queries is empty');
    const results = [];
    const bodies = [];
    for (const q of lp.queries) {
      const r = await localPackCheck({ query: q, business_name: config.site.name, website: config.site.url, lat: lp.lat, lng: lp.lng, radius_m: lp.radius_m });
      results.push(r);
      bodies.push(formatLocalPack(r, config.site.name));
    }
    return { data: { results }, body: bodies.join('\n\n---\n\n'), diff: diffMap };
  },

  async 'rival-scout'(config) {
    const rivals = (config.rivals || []).filter((r) => r.url);
    if (!rivals.length) throw new Error('config.rivals has no URLs');
    const headless = Boolean(config.rival_scout?.headless);
    const auditOne = async (t) => {
      try { return { label: t.label, url: t.url, audit: await engine.runAudit(engine.normalizeUrl(t.url), engine.defaultOptions({ headless, quiet: true })) }; }
      catch (e) { return { label: t.label, url: t.url, audit: null, error: e.message }; }
    };
    const you = await auditOne({ label: config.site.name, url: config.site.url });
    const others = [];
    for (const r of rivals) others.push(await auditOne(r)); // one at a time: gentle on everyone's servers
    const gap = buildGapReport(you, others);
    return { data: { gap }, body: formatGapReport(gap, 15), diff: diffRivals };
  }
};

/* ---------------------------------------------------------------------------
 * Runner
 * -------------------------------------------------------------------------*/

function renderChanges(changes, prevStamp) {
  if (prevStamp == null) return '## What changed\n\n_First run — this report is the baseline for next time._\n';
  if (!changes.length) return `## What changed since ${prevStamp}\n\nNothing notable.\n`;
  const icon = { alert: '🔴', warn: '🟡', good: '🟢' };
  return `## What changed since ${prevStamp}\n\n${changes.map((c) => `- ${icon[c.level] || '-'} ${c.text}`).join('\n')}\n`;
}

async function notify(bot, site, changes, file) {
  const url = process.env.REPORT_WEBHOOK_URL;
  if (!url) return false;
  const top = changes.slice(0, 8).map((c) => `• ${c.text}`).join('\n');
  const msg = `SlickLab ${bot} — ${site}\n${changes.length ? top : 'No notable changes.'}\nReport: ${file}`.slice(0, 1900);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: msg, content: msg }) });
  return res.ok;
}

async function runBot(name, config, { now = new Date() } = {}) {
  const bot = BOTS[name];
  if (!bot) throw new Error(`Unknown bot "${name}". Choose: ${Object.keys(BOTS).join(', ')}`);
  if (!config.site || !config.site.url) throw new Error('config.site.url is required');

  const dir = reportsDir(config);
  const prev = previousRun(dir, name);
  const out = await bot(config);
  const data = { bot: name, site: config.site.url, run_at: now.toISOString(), ...out.data };
  const changes = out.diff(data, prev);
  data.changes = changes;

  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10)}_${iso.slice(11, 19).replace(/:/g, '')}`;
  const md = [`# ${name} — ${clean(config.site.name || config.site.url)} — ${iso.slice(0, 16).replace('T', ' ')} UTC`, '', renderChanges(changes, prev ? prev.run_at.slice(0, 10) : null), out.body, ''].join('\n');
  const file = save(dir, name, stamp, data, md);
  const notified = await notify(name, config.site.name || config.site.url, changes, file).catch(() => false);
  return { file, changes, notified };
}

function loadConfig(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`Could not read config ${p}: ${e.message}. Copy bots/config.example.json to bots/config.json and edit it.`); }
}

async function main(argv) {
  const args = argv.slice(2);
  const name = args.find((a) => !a.startsWith('--'));
  const ci = args.indexOf('--config');
  const configPath = ci !== -1 ? args[ci + 1] : path.join(__dirname, 'config.json');
  if (!name || args.includes('--help')) {
    console.error(`usage: node bots/run.js <${Object.keys(BOTS).join('|')}> [--config path]`);
    return name ? 0 : 1;
  }
  const { file, changes, notified } = await runBot(name, loadConfig(configPath));
  console.error(`${name}: ${changes.length} change(s) · report ${file}${notified ? ' · webhook sent' : ''}`);
  return 0;
}

if (require.main === module) {
  main(process.argv).then((c) => process.exit(c)).catch((e) => { console.error(`bot failed: ${e.message}`); process.exit(1); });
}

module.exports = { runBot, diffWatchtower, diffRanks, diffMap, diffRivals, renderChanges, reportsDir, BOTS };
