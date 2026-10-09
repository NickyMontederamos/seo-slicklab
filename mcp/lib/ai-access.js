'use strict';

/**
 * Fast AI-readability check: robots.txt rules per crawler, llms.txt, and
 * whether the raw HTML (what most crawlers see) carries real content.
 * No headless browser — a few plain HTTP requests per site.
 */

const cheerio = require('cheerio');
const engine = require('../../seo-slicklab.js');

/** Crawlers grouped by what they do. Search = answers live questions; training = model training. */
const CRAWLERS = [
  { bot: 'OAI-SearchBot', operator: 'OpenAI', purpose: 'search' },
  { bot: 'ChatGPT-User', operator: 'OpenAI', purpose: 'search' },
  { bot: 'Claude-SearchBot', operator: 'Anthropic', purpose: 'search' },
  { bot: 'Claude-User', operator: 'Anthropic', purpose: 'search' },
  { bot: 'PerplexityBot', operator: 'Perplexity', purpose: 'search' },
  { bot: 'Bingbot', operator: 'Microsoft (Bing, Copilot)', purpose: 'search' },
  { bot: 'Googlebot', operator: 'Google', purpose: 'search' },
  { bot: 'GPTBot', operator: 'OpenAI', purpose: 'training' },
  { bot: 'ClaudeBot', operator: 'Anthropic', purpose: 'training' },
  { bot: 'Google-Extended', operator: 'Google (Gemini)', purpose: 'training' },
  { bot: 'Applebot-Extended', operator: 'Apple', purpose: 'training' },
  { bot: 'CCBot', operator: 'Common Crawl', purpose: 'training' }
];

/** True when a "text file" response is really an HTML page (SPA catch-all or soft 404). */
function looksLikeHtml(res) {
  const ct = String(res.contentType || '').toLowerCase();
  const head = String(res.text || '').trimStart().slice(0, 200).toLowerCase();
  return ct.includes('text/html') || head.startsWith('<!doctype') || head.startsWith('<html');
}

/** Words a reader can see — script, style and template contents excluded. */
function visibleWordCount(html) {
  const $ = cheerio.load(html || '');
  $('script, style, noscript, template, svg').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return text ? text.split(' ').length : 0;
}

/**
 * @param {{url:string, page:{status:number,text:string}, robots:{status:number,text:string,contentType?:string},
 *          llms:{status:number,text:string,contentType?:string}}} input
 */
function analyzeAiAccess({ url, page, robots, llms }) {
  const findings = [];

  // ---- robots.txt ----
  const robotsValid = robots.status === 200 && !looksLikeHtml(robots);
  const parsed = robotsValid ? engine.parseRobotsTxt(robots.text) : { groups: [], sitemaps: [] };
  const bots = CRAWLERS.map((c) => ({ ...c, blocked: robotsValid && engine.isBotBlocked(parsed, c.bot) }));
  const blocked = bots.filter((b) => b.blocked);

  if (!robotsValid) {
    findings.push({ impact: 'low', title: 'No valid robots.txt',
      detail: robots.status === 200 ? '/robots.txt returns an HTML page, not a robots file.' : `/robots.txt returned HTTP ${robots.status || 'error'}.`,
      fix: 'Publish a plain-text /robots.txt that allows crawlers and lists your sitemap.' });
  } else if (blocked.length) {
    const search = blocked.filter((b) => b.purpose === 'search');
    findings.push({ impact: search.length ? 'high' : 'medium',
      title: `robots.txt blocks ${blocked.length} crawler${blocked.length === 1 ? '' : 's'}`,
      detail: blocked.map((b) => `${b.bot} (${b.purpose})`).join(', '),
      fix: search.length
        ? 'Search crawlers are blocked, so assistants answering live questions cannot read the site. Allow them unless this is deliberate.'
        : 'Only training crawlers are blocked. Fine if deliberate; remove the rule if not.' });
  }
  if (robotsValid && !parsed.sitemaps.length) {
    findings.push({ impact: 'low', title: 'robots.txt has no Sitemap line',
      fix: 'Add "Sitemap: https://<your-domain>/sitemap.xml" to robots.txt.' });
  }

  // ---- llms.txt ----
  const llmsPresent = engine.isTextFile(llms);
  if (!llmsPresent) {
    findings.push({ impact: 'medium', title: 'No llms.txt',
      detail: llms.status === 200 && looksLikeHtml(llms)
        ? '/llms.txt returns an HTML page (a catch-all route), so it looks present but is not.'
        : `/llms.txt returned HTTP ${llms.status || 'error'}.`,
      fix: 'Publish a plain-text /llms.txt: what you do, who it is for, where you operate, how to reach you, key links.' });
  }

  // ---- raw HTML (no JavaScript) ----
  const doc = engine.extractDocument(page.text, url, 'raw');
  const words = visibleWordCount(page.text);
  const jsShell = words < 80 && doc.scripts.length > 0;
  if (page.status >= 400 || page.status === 0) {
    findings.push({ impact: 'high', title: `Page returned HTTP ${page.status || 'error'}`,
      fix: 'Crawlers cannot read a page that does not load. Fix the server response first.' });
  } else if (jsShell) {
    findings.push({ impact: 'high', title: 'Content only appears after JavaScript runs',
      detail: `Raw HTML has ${words} visible words. Most AI crawlers do not run JavaScript, so they see an empty page.`,
      fix: 'Server-render or pre-render the main content (SSR/SSG), or at least the headline, description, and contact facts.' });
  }
  if (!doc.jsonLdTypes.length) {
    findings.push({ impact: 'high', title: 'No schema.org structured data in raw HTML',
      fix: 'Add JSON-LD (Organization / LocalBusiness, SoftwareApplication, FAQPage) describing only what is visible on the page.' });
  }
  if (!doc.title) findings.push({ impact: 'medium', title: 'No <title> in raw HTML', fix: 'Add a descriptive title under ~60 characters.' });
  if (!doc.metaDescription) findings.push({ impact: 'low', title: 'No meta description', fix: 'Add a plain-language description under ~155 characters.' });

  const rank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.impact] - rank[b.impact]);

  return {
    url,
    http_status: page.status,
    robots_txt: { valid: robotsValid, sitemaps: parsed.sitemaps },
    crawlers: bots,
    llms_txt: { present: llmsPresent, status: llms.status },
    raw_html: {
      title: doc.title, meta_description: doc.metaDescription,
      h1: doc.h1s.slice(0, 3).map((h) => h.text), word_count: words,
      json_ld_types: doc.jsonLdTypes, looks_like_js_shell: jsShell
    },
    findings
  };
}

/** Fetch what a crawler would fetch, then analyze it. */
async function checkAiAccess(url, timeout = 15000) {
  const opts = engine.defaultOptions({ timeout });
  const target = engine.normalizeUrl(url);
  const page = await engine.fetchText(target, opts);
  if (page.error) throw new Error(`Could not fetch ${target}: ${page.error}`);
  let origin;
  try { origin = new URL(page.url || target).origin; } catch { origin = new URL(target).origin; }
  const [robots, llms] = await Promise.all([
    engine.fetchText(origin + '/robots.txt', opts),
    engine.fetchText(origin + '/llms.txt', opts)
  ]);
  return analyzeAiAccess({ url: target, page, robots, llms });
}

function formatAiAccess(r) {
  const L = [];
  L.push(`# AI access — ${r.url}`);
  L.push('');
  L.push(`HTTP ${r.http_status} · raw HTML ${r.raw_html.word_count} words · schema: ${r.raw_html.json_ld_types.join(', ') || 'none'} · llms.txt: ${r.llms_txt.present ? 'yes' : 'no'}`);
  L.push('');
  if (r.findings.length) {
    L.push('## Findings');
    r.findings.forEach((f, i) => {
      L.push(`${i + 1}. **[${f.impact}] ${f.title}**${f.detail ? ` — ${f.detail}` : ''}`);
      L.push(`   Fix: ${f.fix}`);
    });
  } else {
    L.push('No AI-access problems found.');
  }
  L.push('');
  L.push('## Crawlers');
  L.push('| Crawler | Operator | Purpose | Allowed |');
  L.push('|---|---|---|---|');
  for (const b of r.crawlers) L.push(`| ${b.bot} | ${b.operator} | ${b.purpose} | ${b.blocked ? 'BLOCKED' : 'yes'} |`);
  L.push('');
  L.push('_Allowed means robots.txt does not disallow the whole site. robots.txt is a request; firewalls and bot-protection services can still block crawlers._');
  return L.join('\n');
}

module.exports = { CRAWLERS, looksLikeHtml, visibleWordCount, analyzeAiAccess, checkAiAccess, formatAiAccess };
