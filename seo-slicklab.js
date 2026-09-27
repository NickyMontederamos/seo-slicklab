#!/usr/bin/env node
/**
 * ============================================================================
 *  SEO-slicklab v2.1.0 — Technical, GEO & CWV Audit Engine
 * ----------------------------------------------------------------------------
 *  10 Engines:
 *    1. Metadata & Social Share      6. Schema.org & Rich Results
 *    2. AI / GEO Validator           7. E-E-A-T & Trust Signals
 *    3. JS Rendering & Hydration     8. Server Rules, Protocol & Security
 *    4. DOM Architecture & Headings  9. Performance & Core Web Vitals
 *    5. Deep Link & Navigation      10. Scoring, Fix Generator & Reporting
 *
 *  Requires : Node >= 18, cheerio, playwright (optional but recommended)
 *  Usage    : node seo-slicklab.js https://example.com [options]
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');

/* ============================================================================
 * 0. CONSTANTS
 * ==========================================================================*/

const VERSION = '2.1.0';
const TOOL = 'SEO-slicklab';
const NETWORK_IDLE_MS = 500;
const EXT_LINK_CONCURRENCY = 5;
const MAX_EXT_LINKS = 15;

const UA_PROFILES = {
  slicklab_default: `${TOOL}/${VERSION} (+https://seo.slicklab.digital/bot)`,
  googlebot_desktop: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  googlebot_mobile:
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 ' +
    '(compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
};

/** AI crawlers segmented by purpose. */
const AI_CRAWLERS = {
  search:   ['OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Claude-SearchBot', 'Google-Extended'],
  training: ['GPTBot', 'ClaudeBot', 'CCBot', 'anthropic-ai', 'Bytespider', 'Applebot-Extended'],
  all:      ['OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Claude-SearchBot',
             'GPTBot', 'ClaudeBot', 'CCBot', 'anthropic-ai', 'Bytespider', 'Google-Extended', 'Applebot-Extended']
};

const MODULE_META = {
  meta_and_social:        { n: 1,  label: 'Metadata & Social Share',       weight: 12, category: 'SEO' },
  geo_ai_validator:       { n: 2,  label: 'AI / GEO Validator',           weight: 12, category: 'GEO' },
  js_render_diff:         { n: 3,  label: 'JS Rendering & Hydration',     weight: 14, category: 'Rendering' },
  dom_headings:           { n: 4,  label: 'DOM Architecture & Headings',  weight: 8,  category: 'Rendering' },
  link_navigation:        { n: 5,  label: 'Deep Link & Navigation',       weight: 10, category: 'SEO' },
  schema_rich:            { n: 6,  label: 'Schema.org & Rich Results',    weight: 10, category: 'SEO' },
  eeat_trust:             { n: 7,  label: 'E-E-A-T & Trust Signals',      weight: 10, category: 'SEO' },
  server_security:        { n: 8,  label: 'Server Rules & Security',      weight: 10, category: 'Security' },
  performance_cwv:        { n: 9,  label: 'Performance & CWV',            weight: 12, category: 'Performance' },
  scoring_reporting:      { n: 10, label: 'Scoring & Reporting',          weight: 2,  category: 'Meta' }
};

const SEVERITY_WEIGHT = { critical: 6, warning: 3, notice: 1, info: 1 };

/* ============================================================================
 * 1. OPTIONAL DEPENDENCIES
 * ==========================================================================*/

let cheerio;
try { cheerio = require('cheerio'); }
catch {
  console.error('\n  ✖ Missing dependency: cheerio\n    npm install cheerio\n');
  process.exit(2);
}

let playwright = null;
let playwrightErr = null;
try { playwright = require('playwright'); }
catch (e1) {
  try { playwright = require('playwright-core'); }
  catch (e2) { playwright = null; playwrightErr = e1.message; }
}

/* ============================================================================
 * 2. LOGGING / ANSI
 * ==========================================================================*/

const COLORS = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c = (code) => (s) => (COLORS ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = c('31'), green = c('32'), yellow = c('33'), blue = c('34');
const magenta = c('35'), cyan = c('36'), gray = c('90');
const bold = c('1'), dim = c('2');

let QUIET = false;
const log = (...a) => { if (!QUIET) console.error(...a); };
const step = (msg) => log(gray('  › ') + msg);

/* ============================================================================
 * 3. HELPERS
 * ==========================================================================*/

function normalizeUrl(input) {
  let s = String(input).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s); u.hash = '';
  return u.href;
}
function safeUrl(href, base) {
  if (!href) return null;
  try { return new URL(href, base).href; } catch { return null; }
}
function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}
function truncate(s, n = 100) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function safeJsonParse(str) { try { return { ok: true, value: JSON.parse(str) }; } catch (e) { return { ok: false, error: e.message }; } }

async function withTimeout(promise, ms, label) {
  let t;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); })
    ]);
  } finally { clearTimeout(t); }
}

/** Estimate pixel width of a string using Google's ~8.5px/char approximation. */
function pixelWidth(str) { return Math.round(String(str || '').length * 8.5); }

/* ============================================================================
 * 4. CLI PARSING
 * ==========================================================================*/

function parseArgs(argv) {
  const o = {
    url: null, format: 'text', out: null, timeout: 30000,
    profile: 'slicklab_default', headless: true, external: false,
    social: true, llms: true, probe: false, quiet: false, verbose: false,
    failUnder: null, help: false, version: false
  };
  const args = argv.slice(2);
  const nextVal = (flag, i) => {
    const v = args[i + 1];
    if (v === undefined) { console.error(`Missing value for ${flag}`); process.exit(1); }
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      case '--json': o.format = 'json'; break;
      case '--markdown': case '--md': o.format = 'markdown'; break;
      case '-f': case '--format': {
        o.format = String(nextVal(a, i++)).toLowerCase();
        if (o.format === 'md') o.format = 'markdown';
        if (!['text', 'json', 'markdown'].includes(o.format)) {
          console.error(`Unknown format: ${o.format}`); process.exit(1);
        }
        break;
      }
      case '-o': case '--out': o.out = nextVal(a, i++); break;
      case '-t': case '--timeout': o.timeout = parseInt(nextVal(a, i++), 10) || 30000; break;
      case '--user-agent': case '--profile': o.profile = nextVal(a, i++); break;
      case '--no-headless': o.headless = false; break;
      case '--check-external-links': o.external = true; break;
      case '--no-social': o.social = false; break;
      case '--no-llms': o.llms = false; break;
      case '--probe-ai-bots': o.probe = true; break;
      case '-q': case '--quiet': o.quiet = true; break;
      case '--verbose': o.verbose = true; break;
      case '--fail-under': o.failUnder = parseInt(nextVal(a, i++), 10); break;
      default:
        if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1); }
        if (!o.url) o.url = a;
        break;
    }
  }
  return o;
}

function printHelp() {
  console.log(`
${bold(`${TOOL} v${VERSION}`)} — Technical, GEO, CWV & AI Search Audit Engine

${bold('USAGE')}
  seo-slicklab <url> [options]

${bold('OPTIONS')}
  -f, --format <text|json|markdown>  Output format (default: text)
  -o, --out <file>                   Write report to a file
  -t, --timeout <ms>                 Per-request timeout (default: 30000)
      --profile <name>               slicklab_default | googlebot_desktop | googlebot_mobile
      --no-headless                  Skip headless DOM fetch (raw HTTP only)
      --check-external-links         HEAD-check outbound links (slower)
      --no-social                    Skip social image verification
      --no-llms                      Skip /llms.txt + robots.txt AI checks
      --probe-ai-bots                Send a live request as GPTBot
      --fail-under <score>           Exit 1 if overall score < N
  -q, --quiet                        Suppress progress on stderr
      --verbose                      Extra diagnostics
  -v, --version / -h, --help

${bold('EXAMPLES')}
  seo-slicklab https://example.com
  seo-slicklab example.com --format json --out audit.json
  seo-slicklab example.com --profile googlebot_mobile --check-external-links
  seo-slicklab example.com --probe-ai-bots --fail-under 80

${bold('ENVIRONMENT')}
  NO_COLOR=1     Disable ANSI colours
  SLICKLAB_UA    Override the default User-Agent
`);
}

/* ============================================================================
 * 5. NETWORK LAYER
 * ==========================================================================*/

async function fetchRaw(targetUrl, opts, overrideUa) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout);
  const ua = overrideUa || process.env.SLICKLAB_UA || UA_PROFILES[opts.profile] || UA_PROFILES.slicklab_default;
  const t0 = performance.now();

  let res;
  try {
    res = await fetch(targetUrl, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      }
    });
  } finally { clearTimeout(timer); }

  const ttfb = Math.round(performance.now() - t0);
  const html = await res.text();
  const total = Math.round(performance.now() - t0);

  const headers = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  return {
    requestedUrl: targetUrl,
    finalUrl: res.url || targetUrl,
    status: res.status,
    ok: res.ok,
    redirected: (res.url || targetUrl) !== targetUrl,
    headers,
    html,
    bytes: Buffer.byteLength(html, 'utf8'),
    userAgent: ua,
    timing: { ttfb_ms: ttfb, total_ms: total }
  };
}

async function fetchText(url, opts, ua) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(opts.timeout, 15000));
  try {
    const res = await fetch(url, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': ua || UA_PROFILES.slicklab_default,
                 Accept: 'text/plain,text/markdown,text/html,*/*' }
    });
    const text = await res.text();
    return {
      url, status: res.status, ok: res.ok,
      contentType: res.headers.get('content-type') || '',
      bytes: Buffer.byteLength(text, 'utf8'),
      text, error: null
    };
  } catch (e) {
    return { url, status: 0, ok: false, contentType: '', bytes: 0, text: '', error: e.message };
  } finally { clearTimeout(timer); }
}

async function headCheck(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(opts.timeout, 10000));
  try {
    const res = await fetch(url, {
      method: 'HEAD', redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': UA_PROFILES.slicklab_default }
    });
    const cl = res.headers.get('content-length');
    return {
      url, status: res.status, ok: res.ok,
      contentType: res.headers.get('content-type') || '',
      contentLength: cl ? parseInt(cl, 10) : null,
      error: null
    };
  } catch (e) {
    return { url, status: 0, ok: false, contentType: '', contentLength: null, error: e.message };
  } finally { clearTimeout(timer); }
}

async function fetchHeadless(targetUrl, opts) {
  if (!playwright) return { available: false, error: playwrightErr || 'playwright not installed', html: null };
  if (!opts.headless) return { available: false, error: 'disabled via --no-headless', html: null };

  const { chromium } = playwright;
  const t0 = performance.now();
  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const ctx = await browser.newContext({
      userAgent: process.env.SLICKLAB_UA || UA_PROFILES[opts.profile] || UA_PROFILES.slicklab_default,
      viewport: { width: 1366, height: 900 },
      ignoreHTTPSErrors: true
    });
    const page = await ctx.newPage();

    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String((e && e.message) || e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    const responses = [];
    page.on('response', (r) => {
      try { responses.push({ url: r.url(), status: r.status(), type: r.request().resourceType() }); }
      catch { /* ignore */ }
    });

    const redirects = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) redirects.push(frame.url());
    });

    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: opts.timeout
    });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await sleep(NETWORK_IDLE_MS);

    const html = await page.content();
    const finalUrl = page.url();
    const status = response ? response.status() : 0;
    const headers = response ? response.headers() : {};

    const navMetrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      return {
        responseEnd: Math.round(nav.responseEnd || 0),
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
        loadEvent: Math.round(nav.loadEventEnd || 0)
      };
    }).catch(() => ({}));

    const resources = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((r) => ({
        name: r.name, initiatorType: r.initiatorType,
        transferSize: r.transferSize || 0, duration: Math.round(r.duration || 0)
      }))
    ).catch(() => []);

    const domLoadMs = Math.round(performance.now() - t0);
    await ctx.close();

    return {
      available: true, error: null, html, finalUrl, status, headers,
      domLoadMs, consoleErrors: consoleErrors.slice(0, 25),
      responses, navMetrics, resources, redirects
    };
  } catch (err) {
    return {
      available: true, error: err.message, html: null,
      consoleErrors: [], responses: [], resources: [], redirects: []
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/* ============================================================================
 * 6. ROBOTS.TXT PARSER
 * ==========================================================================*/

function parseRobotsTxt(txt) {
  const groups = [];
  const sitemaps = [];
  let current = null;

  String(txt || '').split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) return;
    const idx = line.indexOf(':');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();

    if (key === 'user-agent') {
      if (current && current.rules.length === 0) current.agents.push(val.toLowerCase());
      else { current = { agents: [val.toLowerCase()], rules: [] }; groups.push(current); }
    } else if (key === 'disallow' || key === 'allow') {
      if (!current) { current = { agents: ['*'], rules: [] }; groups.push(current); }
      current.rules.push({ type: key, path: val });
    } else if (key === 'sitemap') {
      sitemaps.push(val);
    }
  });
  return { groups, sitemaps };
}

function isBotBlocked(parsed, botName) {
  const b = String(botName).toLowerCase();
  const exact = parsed.groups.filter((g) => g.agents.includes(b));
  const wildcard = parsed.groups.filter((g) => g.agents.includes('*'));
  const relevant = exact.length ? exact : wildcard;
  if (!relevant.length) return false;
  const rules = relevant.flatMap((g) => g.rules);
  const disallowAll = rules.some((r) => r.type === 'disallow' && (r.path === '/' || r.path === '/*'));
  const allowAll = rules.some((r) => r.type === 'allow' && (r.path === '/' || r.path === '/*'));
  return disallowAll && !allowAll;
}

/* ============================================================================
 * 7. DOCUMENT EXTRACTION
 * ==========================================================================*/

function computeMaxDepth($) {
  let max = 0;
  const stack = [{ nodes: $.root()[0].children || [], depth: 1 }];
  while (stack.length) {
    const { nodes, depth } = stack.pop();
    if (depth > max) max = depth;
    for (const n of nodes) {
      if (n.children && n.children.length) stack.push({ nodes: n.children, depth: depth + 1 });
    }
  }
  return max;
}

function extractDocument(html, baseUrl, label) {
  const $ = cheerio.load(html || '');

  const title = ($('head title').first().text() || $('title').first().text() || '').trim();

  const metas = {}; const metaCounts = {};
  $('meta').each((_, el) => {
    const $el = $(el);
    const key = ($el.attr('name') || $el.attr('property') || $el.attr('http-equiv') || '').toLowerCase();
    if (!key) return;
    metaCounts[key] = (metaCounts[key] || 0) + 1;
    if (!(key in metas)) metas[key] = $el.attr('content') || '';
  });

  const canonical = $('link[rel="canonical"]').attr('href') || null;
  const canonicalAbs = canonical ? safeUrl(canonical, baseUrl) : null;

  const headings = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    const tag = (el.tagName || '').toLowerCase();
    headings.push({ level: Number(tag[1]) || 0, text: $(el).text().replace(/\s+/g, ' ').trim() });
  });
  const h1s = headings.filter((h) => h.level === 1);

  const links = [];
  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    if (!href) return;
    const trimmed = href.trim();
    const resolved = safeUrl(href, baseUrl);
    const isAnchor = trimmed.startsWith('#');
    const isProtocolRelative = trimmed.startsWith('//');
    const isSpecial = /^(javascript:|mailto:|tel:)/i.test(trimmed);
    if (isSpecial) return;
    links.push({
      href: trimmed, resolved,
      text: $el.text().replace(/\s+/g, ' ').trim(),
      rel: ($el.attr('rel') || '').toLowerCase(),
      target: ($el.attr('target') || '').toLowerCase(),
      ariaLabel: $el.attr('aria-label') || null,
      title: $el.attr('title') || null,
      internal: resolved ? sameOrigin(resolved, baseUrl) : false,
      isAnchor, isProtocolRelative,
      hasImage: $el.find('img').length > 0
    });
  });

  const images = [];
  $('img').each((_, el) => {
    const $el = $(el);
    const attribs = el.attribs || {};
    const src = $el.attr('src') || $el.attr('data-src') || null;
    images.push({
      src, abs: safeUrl(src, baseUrl),
      hasAltAttr: Object.prototype.hasOwnProperty.call(attribs, 'alt'),
      alt: $el.attr('alt') || '',
      width: $el.attr('width') || null,
      height: $el.attr('height') || null,
      loading: ($el.attr('loading') || '').toLowerCase() || null,
      fetchpriority: ($el.attr('fetchpriority') || '').toLowerCase() || null,
      srcset: $el.attr('srcset') || null,
      hasStyleDims: /width|height/.test($el.attr('style') || ''),
      insidePicture: $el.parents('picture').length > 0
    });
  });

  const iframes = [];
  $('iframe').each((_, el) => {
    const $el = $(el);
    iframes.push({
      src: $el.attr('src') || null,
      width: $el.attr('width') || null,
      height: $el.attr('height') || null,
      hasDims: Boolean($el.attr('width') && $el.attr('height'))
    });
  });

  const scripts = [];
  let inlineScriptBytes = 0;
  $('script').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src');
    const type = ($el.attr('type') || '').toLowerCase();
    const inHead = $el.parents('head').length > 0;
    const content = $el.html() || '';
    if (!src) inlineScriptBytes += Buffer.byteLength(content, 'utf8');
    scripts.push({
      src: src || null, abs: src ? safeUrl(src, baseUrl) : null,
      type, async: Object.prototype.hasOwnProperty.call(el.attribs || {}, 'async'),
      defer: Object.prototype.hasOwnProperty.call(el.attribs || {}, 'defer'),
      isModule: type === 'module', isJsonLd: type === 'application/ld+json',
      inHead, inlineBytes: src ? 0 : Buffer.byteLength(content, 'utf8'),
      blocking: Boolean(src) && inHead && !el.attribs.async && !el.attribs.defer && type !== 'module'
    });
  });

  const stylesheets = [];
  $('link[rel="stylesheet"]').each((_, el) => {
    const $el = $(el);
    const media = ($el.attr('media') || '').toLowerCase();
    stylesheets.push({
      href: $el.attr('href') || null, abs: safeUrl($el.attr('href'), baseUrl),
      media, renderBlocking: media !== 'print' && media !== 'preload'
    });
  });

  let inlineStyleBytes = 0;
  $('style').each((_, el) => { inlineStyleBytes += Buffer.byteLength($(el).html() || '', 'utf8'); });
  $('[style]').each((_, el) => { inlineStyleBytes += Buffer.byteLength($(el).attr('style') || '', 'utf8'); });

  const jsonLd = []; const jsonLdErrors = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = ($(el).html() || '').trim();
    if (!raw) return;
    const parsed = safeJsonParse(raw);
    if (parsed.ok) jsonLd.push(parsed.value);
    else jsonLdErrors.push(parsed.error);
  });

  const jsonLdTypes = [];
  const collectTypes = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collectTypes); return; }
    if (node['@type']) {
      Array.isArray(node['@type']) ? jsonLdTypes.push(...node['@type']) : jsonLdTypes.push(node['@type']);
    }
    if (node['@graph']) collectTypes(node['@graph']);
  };
  jsonLd.forEach(collectTypes);

  const microdataItems = $('[itemscope]').length;

  const semantic = {};
  ['main', 'nav', 'header', 'footer', 'article', 'section', 'aside', 'figure', 'address', 'time']
    .forEach((tag) => { semantic[tag] = $(tag).length; });

  const nodeCount = $('*').length;
  const maxDepth = computeMaxDepth($);

  const idCounts = {};
  $('[id]').each((_, el) => { const id = $(el).attr('id'); if (id) idCounts[id] = (idCounts[id] || 0) + 1; });
  const duplicateIds = Object.entries(idCounts).filter(([, n]) => n > 1).map(([id, n]) => ({ id, count: n }));

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;

  const rawTrim = String(html || '').trimStart().toLowerCase();
  const hasDoctype = rawTrim.startsWith('<!doctype');
  const charset = $('meta[charset]').attr('charset') || (metas['content-type'] || '').match(/charset=([\w-]+)/i)?.[1] || null;
  const lang = $('html').attr('lang') || null;
  const viewport = metas['viewport'] || null;

  const preloadImages = $('link[rel="preload"][as="image"]').length;
  const preloadScripts = $('link[rel="preload"][as="script"]').length;
  const preconnect = $('link[rel="preconnect"]').length;

  const deprecatedTags = [];
  ['font', 'center', 'marquee', 'blink', 'big', 'strike', 'tt', 'frame', 'frameset', 'applet']
    .forEach((t) => { const n = $(t).length; if (n) deprecatedTags.push({ tag: t, count: n }); });

  const og = {
    title: metas['og:title'] || null,
    description: metas['og:description'] || null,
    image: metas['og:image'] ? safeUrl(metas['og:image'], baseUrl) : null,
    imageWidth: metas['og:image:width'] || null,
    imageHeight: metas['og:image:height'] || null,
    type: metas['og:type'] || null,
    url: metas['og:url'] || null,
    siteName: metas['og:site_name'] || null
  };
  const twitter = {
    card: metas['twitter:card'] || null,
    title: metas['twitter:title'] || null,
    description: metas['twitter:description'] || null,
    image: metas['twitter:image'] ? safeUrl(metas['twitter:image'], baseUrl) : null
  };

  const noai = Boolean(metas['noai'] || metas['noimageai']);
  const noaiValue = { noai: metas['noai'] || null, noimageai: metas['noimageai'] || null };

  const authorMeta = metas['author'] || metas['article:author'] || null;
  const publishedTime = metas['article:published_time'] || metas['datePublished'] || null;
  const modifiedTime = metas['article:modified_time'] || metas['dateModified'] || null;

  const favicon = $('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').length > 0;
  const faviconHref = $('link[rel="icon"], link[rel="shortcut icon"]').first().attr('href') || null;

  const hreflang = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    hreflang.push({ lang: $(el).attr('hreflang'), href: $(el).attr('href') });
  });

  const source = html || '';
  const lower = source.toLowerCase();
  const textToHtmlRatio = source.length > 0 ? Math.round((bodyText.length / source.length) * 100) : 0;

  const hasFAQ = /\b(faq|frequently asked questions|q&a)\b/i.test(bodyText);
  const hasLists = lower.includes('<ul') || lower.includes('<ol');
  const hasTables = lower.includes('<table');

  return {
    label, baseUrl, title, titleLength: title.length,
    metas, metaCounts,
    metaDescription: metas['description'] || '',
    metaRobots: (metas['robots'] || '').toLowerCase(),
    canonical, canonicalAbs,
    headings, h1s, links, images, iframes, scripts, stylesheets,
    inlineScriptBytes, inlineStyleBytes,
    jsonLd, jsonLdErrors, jsonLdTypes, microdataItems, semantic,
    nodeCount, maxDepth, duplicateIds, text: bodyText, wordCount,
    htmlBytes: Buffer.byteLength(source, 'utf8'),
    hasDoctype, charset, lang, viewport,
    preloadImages, preloadScripts, preconnect,
    deprecatedTags, og, twitter, noai, noaiValue,
    authorMeta, publishedTime, modifiedTime,
    favicon, faviconHref, hreflang,
    textToHtmlRatio,
    hasFAQ, hasLists, hasTables,
    hasNoscript: $('noscript').length > 0
  };
}

/* ============================================================================
 * 8. CHECK / SCORING PRIMITIVES
 * ==========================================================================*/

function check(id, label, status, severity, message, extra = {}) {
  return {
    id, label, status,
    severity: status === 'fail' ? severity : 'info',
    message,
    value: extra.value === undefined ? null : extra.value,
    action: extra.action || null
  };
}

function scoreChecks(checks) {
  let total = 0, earned = 0;
  for (const c of checks) {
    if (c.status === 'skip') continue;
    const w = SEVERITY_WEIGHT[c.severity] || 1;
    total += w;
    if (c.status === 'pass') earned += w;
  }
  return total === 0 ? 100 : Math.round((earned / total) * 100);
}

function buildModule(key, checks, data) {
  return {
    key, label: MODULE_META[key].label, weight: MODULE_META[key].weight,
    category: MODULE_META[key].category,
    score: scoreChecks(checks), checks, data: data || null
  };
}

/* ============================================================================
 * 9. ENGINE 1 — METADATA & SOCIAL SHARE VALIDATOR
 * ==========================================================================*/

function engineMetaAndSocial(ctx) {
  const doc = ctx.hydratedDoc || ctx.rawDoc;
  const checks = [];

  // ---- Title ----
  const t = doc.title;
  if (!t) {
    checks.push(check('title.present', 'Title tag present', 'fail', 'critical',
      'No <title> element found.',
      { action: 'Add a unique <title> of 50–60 characters.' }));
  } else {
    checks.push(check('title.present', 'Title tag present', 'pass', 'critical',
      `"${truncate(t, 80)}"`, { value: t }));
    const len = doc.titleLength;
    const px = pixelWidth(t);
    if (len < 15) {
      checks.push(check('title.length', 'Title length (50–60 chars, <580px)', 'fail', 'critical',
        `Only ${len} chars — too short.`, { value: len,
        action: 'Expand to 50–60 characters with primary keyword + brand.' }));
    } else if (len < 50) {
      checks.push(check('title.length', 'Title length (50–60 chars, <580px)', 'fail', 'warning',
        `${len} chars (${px}px) — add more descriptive terms.`, { value: len,
        action: 'Expand to 50–60 characters.' }));
    } else if (len <= 60 && px <= 580) {
      checks.push(check('title.length', 'Title length (50–60 chars, <580px)', 'pass', 'warning',
        `${len} chars, ~${px}px — optimal.`, { value: len }));
    } else if (len <= 70 && px <= 600) {
      checks.push(check('title.length', 'Title length (50–60 chars, <580px)', 'fail', 'warning',
        `${len} chars, ~${px}px — may truncate.`, { value: len,
        action: 'Trim to 60 chars / <580px.' }));
    } else {
      checks.push(check('title.length', 'Title length (50–60 chars, <580px)', 'fail', 'critical',
        `${len} chars, ~${px}px — will be truncated in SERPs.`, { value: len,
        action: 'Rewrite to 50–60 chars / <580px.' }));
    }
  }

  // ---- Meta description ----
  const md = doc.metaDescription;
  if (!md) {
    checks.push(check('meta_description.present', 'Meta description present', 'fail', 'critical',
      'No meta description found.', { action: 'Add <meta name="description"> with 140–160 chars.' }));
  } else {
    checks.push(check('meta_description.present', 'Meta description present', 'pass', 'critical',
      `"${truncate(md, 90)}"`, { value: md }));
    const len = md.length;
    if (len < 70) {
      checks.push(check('meta_description.length', 'Meta description 140–160 chars', 'fail', 'warning',
        `${len} chars — too short.`, { value: len, action: 'Expand to 140–160 chars.' }));
    } else if (len < 140) {
      checks.push(check('meta_description.length', 'Meta description 140–160 chars', 'fail', 'notice',
        `${len} chars — slightly below ideal.`, { value: len, action: 'Expand to 140–160 chars.' }));
    } else if (len <= 160) {
      checks.push(check('meta_description.length', 'Meta description 140–160 chars', 'pass', 'warning',
        `${len} chars — optimal.`, { value: len }));
    } else {
      checks.push(check('meta_description.length', 'Meta description 140–160 chars', 'fail', 'warning',
        `${len} chars — will be truncated.`, { value: len, action: 'Trim to ≤160 chars.' }));
    }
  }

  // ---- H1 ----
  const h1s = doc.h1s;
  if (h1s.length === 0) {
    checks.push(check('h1.present', 'Exactly one H1', 'fail', 'critical',
      'No <h1> found.', { action: 'Add a single descriptive <h1>.' }));
  } else if (h1s.length === 1) {
    checks.push(check('h1.present', 'Exactly one H1', 'pass', 'critical',
      `H1: "${truncate(h1s[0].text, 80)}"`, { value: h1s[0].text }));
  } else {
    checks.push(check('h1.present', 'Exactly one H1', 'fail', 'warning',
      `${h1s.length} <h1> elements found.`, { value: h1s.length,
      action: 'Keep one <h1>; demote extras to <h2>.' }));
  }

  // ---- Heading hierarchy ----
  let skipped = null, prev = 0;
  for (const h of doc.headings) {
    if (prev && h.level > prev + 1) { skipped = { from: prev, to: h.level, text: truncate(h.text, 50) }; break; }
    prev = h.level;
  }
  if (doc.headings.length === 0) {
    checks.push(check('headings.hierarchy', 'Heading hierarchy valid', 'fail', 'warning',
      'No headings found.', { action: 'Structure with H1 → H2 → H3.' }));
  } else if (skipped) {
    checks.push(check('headings.hierarchy', 'Heading hierarchy valid', 'fail', 'notice',
      `Skips from H${skipped.from} to H${skipped.to} at "${skipped.text}".`,
      { action: 'Keep heading levels sequential.' }));
  } else {
    checks.push(check('headings.hierarchy', 'Heading hierarchy valid', 'pass', 'warning',
      `${doc.headings.length} headings with valid nesting.`, { value: doc.headings.length }));
  }

  // ---- Canonical ----
  if (!doc.canonical) {
    checks.push(check('canonical.present', 'Canonical tag present', 'fail', 'warning',
      'No rel="canonical" link.', { action: 'Add <link rel="canonical" href="…">.' }));
  } else if (doc.canonicalAbs && !sameOrigin(doc.canonicalAbs, doc.baseUrl)) {
    checks.push(check('canonical.present', 'Canonical tag present', 'fail', 'critical',
      `Canonical points off-origin: ${truncate(doc.canonicalAbs, 80)}`,
      { value: doc.canonical, action: 'Verify the canonical is intentional — cross-domain canonicals deindex the page.' }));
  } else {
    checks.push(check('canonical.present', 'Canonical tag present', 'pass', 'warning',
      `Canonical: ${truncate(doc.canonicalAbs || doc.canonical, 100)}`, { value: doc.canonical }));
  }

  // ---- Indexability ----
  const robots = doc.metaRobots;
  if (/noindex/.test(robots) || /none/.test(robots)) {
    checks.push(check('robots.noindex', 'Page is indexable', 'fail', 'critical',
      `Meta robots: "${truncate(robots, 60)}" blocks indexing.`,
      { action: 'Remove noindex/none if this page should rank.' }));
  } else {
    checks.push(check('robots.noindex', 'Page is indexable', 'pass', 'critical',
      robots ? `robots: ${truncate(robots, 60)}` : 'No restrictive robots meta.', { value: robots || null }));
  }

  // ---- Open Graph ----
  const ogMissing = [];
  if (!doc.og.title) ogMissing.push('og:title');
  if (!doc.og.description) ogMissing.push('og:description');
  if (!doc.og.image) ogMissing.push('og:image');
  if (!doc.og.url) ogMissing.push('og:url');
  if (!doc.og.type) ogMissing.push('og:type');
  if (ogMissing.length === 0) {
    checks.push(check('og.complete', 'Open Graph tags complete', 'pass', 'warning',
      'All core Open Graph tags present.'));
  } else {
    checks.push(check('og.complete', 'Open Graph tags complete', 'fail', 'warning',
      `Missing: ${ogMissing.join(', ')}`, { value: ogMissing,
      action: `Add ${ogMissing.join(', ')}.` }));
  }

  // ---- OG image dimensions ----
  if (doc.og.image) {
    const w = parseInt(doc.og.imageWidth || '0', 10);
    const h = parseInt(doc.og.imageHeight || '0', 10);
    if ((w && h) && (w < 1200 || h < 630)) {
      checks.push(check('og.image_dims', 'og:image ≥ 1200×630', 'fail', 'notice',
        `Declared dimensions ${w}×${h} below 1200×630.`, { value: { w, h },
        action: 'Provide at least a 1200×630 image and declare og:image:width/height.' }));
    } else if (w && h) {
      checks.push(check('og.image_dims', 'og:image ≥ 1200×630', 'pass', 'notice',
        `${w}×${h}`, { value: { w, h } }));
    } else {
      checks.push(check('og.image_dims', 'og:image ≥ 1200×630', 'fail', 'notice',
        'og:image:width / og:image:height not declared.',
        { action: 'Add og:image:width and og:image:height to avoid slow social rendering.' }));
    }
  } else {
    checks.push(check('og.image_dims', 'og:image ≥ 1200×630', 'skip', 'notice', 'No og:image set.'));
  }

  // ---- Twitter card ----
  if (!doc.twitter.card) {
    checks.push(check('twitter.card', 'Twitter/X card present', 'fail', 'notice',
      'No twitter:card.', { action: 'Add <meta name="twitter:card" content="summary_large_image">.' }));
  } else {
    checks.push(check('twitter.card', 'Twitter/X card present', 'pass', 'notice',
      `twitter:card = ${doc.twitter.card}`, { value: doc.twitter.card }));
  }

  // ---- Viewport ----
  if (!doc.viewport) {
    checks.push(check('viewport.present', 'Mobile viewport declared', 'fail', 'warning',
      'No viewport meta.', { action: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.' }));
  } else {
    checks.push(check('viewport.present', 'Mobile viewport declared', 'pass', 'warning',
      `viewport = ${truncate(doc.viewport, 60)}`, { value: doc.viewport }));
  }

  // ---- Lang ----
  if (!doc.lang) {
    checks.push(check('html.lang', 'HTML lang attribute', 'fail', 'notice',
      'No lang attribute.', { action: 'Add lang="en" (or the correct locale) to <html>.' }));
  } else {
    checks.push(check('html.lang', 'HTML lang attribute', 'pass', 'notice', `lang="${doc.lang}"`, { value: doc.lang }));
  }

  // ---- Favicon ----
  if (!doc.favicon) {
    checks.push(check('favicon.present', 'Favicon declared', 'fail', 'notice',
      'No favicon link found.', { action: 'Add <link rel="icon" href="/favicon.ico">.' }));
  } else {
    checks.push(check('favicon.present', 'Favicon declared', 'pass', 'notice',
      `favicon href: ${truncate(doc.faviconHref || 'declared', 60)}`));
  }

  // ---- Charset ----
  if (!doc.charset) {
    checks.push(check('charset.present', 'Charset declared', 'fail', 'notice',
      'No <meta charset>.', { action: 'Add <meta charset="utf-8"> as the first head element.' }));
  } else {
    checks.push(check('charset.present', 'Charset declared', 'pass', 'notice',
      `charset = ${doc.charset}`, { value: doc.charset }));
  }

  // ---- Image alt ----
  const imgs = doc.images;
  if (imgs.length) {
    const missing = imgs.filter((i) => !i.hasAltAttr).length;
    const empty = imgs.filter((i) => i.hasAltAttr && !i.alt.trim()).length;
    if (missing > 0) {
      checks.push(check('images.alt', 'Images have alt attributes', 'fail', 'warning',
        `${missing}/${imgs.length} images lack alt.`, { value: missing,
        action: 'Add descriptive alt text (or alt="" for decorative images).' }));
    } else if (empty / imgs.length > 0.5) {
      checks.push(check('images.alt', 'Images have alt attributes', 'fail', 'notice',
        `${empty}/${imgs.length} images use empty alt.`, { value: empty,
        action: 'Provide descriptive alt for content images.' }));
    } else {
      checks.push(check('images.alt', 'Images have alt attributes', 'pass', 'warning',
        `All ${imgs.length} images declare alt.`, { value: imgs.length }));
    }
  } else {
    checks.push(check('images.alt', 'Images have alt attributes', 'skip', 'notice', 'No images found.'));
  }

  // ---- Social image reachability ----
  let socialImageStatus = null;
  if (ctx.options.social && (doc.og.image || doc.twitter.image) && ctx.socialImageHead) {
    const h = ctx.socialImageHead;
    socialImageStatus = h;
    if (h.status === 200) {
      checks.push(check('social.image_reachable', 'Social preview image reachable', 'pass', 'warning',
        `${truncate(h.url, 80)} → HTTP ${h.status}` +
        (h.contentLength ? `, ${fmtBytes(h.contentLength)}` : '')));
    } else {
      checks.push(check('social.image_reachable', 'Social preview image reachable', 'fail', 'warning',
        `${truncate(h.url, 80)} → HTTP ${h.status || 'error'}`,
        { value: h.status, action: 'Host the social image publicly and return HTTP 200.' }));
    }
  } else {
    checks.push(check('social.image_reachable', 'Social preview image reachable', 'skip', 'notice',
      ctx.options.social ? 'No social image set.' : 'Skipped via --no-social.'));
  }

  return buildModule('meta_and_social', checks, {
    title: doc.title, title_length: doc.titleLength, title_px: pixelWidth(doc.title),
    meta_description_length: doc.metaDescription.length,
    h1_count: h1s.length, heading_count: doc.headings.length,
    canonical: doc.canonicalAbs, og: doc.og, twitter: doc.twitter,
    favicon: doc.favicon, charset: doc.charset, lang: doc.lang,
    social_image_status: socialImageStatus
  });
}

/* ============================================================================
 * 10. ENGINE 2 — AI / GEO VALIDATOR
 * ==========================================================================*/

function engineGeoValidator(ctx) {
  const checks = [];
  const { robots, llms, llmsFull, aiProbe, options, robotsParsed } = ctx;

  if (!options.llms) {
    checks.push(check('geo.enabled', 'GEO checks enabled', 'skip', 'info', 'Skipped via --no-llms.'));
    return buildModule('geo_ai_validator', checks, null);
  }

  // ---- /llms.txt ----
  if (llms && llms.status === 200 && llms.text.trim()) {
    const text = llms.text;
    const hasH1 = /^#\s+.+/m.test(text);
    const hasBlockquote = /^>\s+.+/m.test(text);
    const hasLinks = /\[.+\]\(.+\)/.test(text);
    const isMarkdown = /(^|\n)#\s/.test(text) || hasLinks;

    checks.push(check('llms_txt.present', '/llms.txt present', 'pass', 'warning',
      `/llms.txt found (${fmtBytes(llms.bytes)}).`, { value: llms.url }));

    if (hasH1) {
      checks.push(check('llms_txt.h1', '/llms.txt has H1 title', 'pass', 'notice',
        'H1 title detected.'));
    } else {
      checks.push(check('llms_txt.h1', '/llms.txt has H1 title', 'fail', 'notice',
        'No H1 title in /llms.txt.',
        { action: 'Start /llms.txt with a single # H1 title (site name).' }));
    }

    if (hasBlockquote) {
      checks.push(check('llms_txt.summary', '/llms.txt has blockquote summary', 'pass', 'notice',
        'Blockquote summary detected.'));
    } else {
      checks.push(check('llms_txt.summary', '/llms.txt has blockquote summary', 'fail', 'notice',
        'No blockquote summary.',
        { action: 'Add a "> Short description" blockquote right after the H1.' }));
    }

    checks.push(check('llms_txt.markdown', '/llms.txt is markdown-structured',
      isMarkdown ? 'pass' : 'fail',
      isMarkdown ? 'notice' : 'warning',
      isMarkdown ? 'Contains markdown headings and/or links.' : 'Does not look like structured markdown.',
      { action: isMarkdown ? null : 'Structure /llms.txt with H1 + blockquote + linked sections.' }));

    if (hasLinks) {
      checks.push(check('llms_txt.links', '/llms.txt links to markdown resources', 'pass', 'notice',
        'Contains markdown links.'));
    } else {
      checks.push(check('llms_txt.links', '/llms.txt links to markdown resources', 'fail', 'notice',
        'No markdown links.',
        { action: 'Link to key pages / markdown docs so LLMs can traverse.' }));
    }
  } else {
    checks.push(check('llms_txt.present', '/llms.txt present', 'fail', 'warning',
      llms && llms.status ? `/llms.txt returned HTTP ${llms.status}.` : 'No /llms.txt found.',
      { action: 'Publish /llms.txt at the site root for LLM discoverability.' }));
    checks.push(check('llms_txt.h1', '/llms.txt has H1 title', 'skip', 'notice', '/llms.txt missing.'));
    checks.push(check('llms_txt.summary', '/llms.txt has blockquote summary', 'skip', 'notice', '/llms.txt missing.'));
    checks.push(check('llms_txt.markdown', '/llms.txt is markdown-structured', 'skip', 'notice', '/llms.txt missing.'));
    checks.push(check('llms_txt.links', '/llms.txt links to markdown resources', 'skip', 'notice', '/llms.txt missing.'));
  }

  // ---- /llms-full.txt ----
  if (llmsFull && llmsFull.status === 200 && llmsFull.text.trim()) {
    checks.push(check('llms_full.present', '/llms-full.txt present', 'pass', 'notice',
      `/llms-full.txt found (${fmtBytes(llmsFull.bytes)}).`, { value: llmsFull.url }));
  } else {
    checks.push(check('llms_full.present', '/llms-full.txt present', 'fail', 'notice',
      'No /llms-full.txt expanded corpus.',
      { action: 'Optionally publish /llms-full.txt with the full markdown corpus.' }));
  }

  // ---- AI crawler permissions ----
  if (robots && robots.status === 200 && robots.text && robotsParsed) {
    const blockedSearch = AI_CRAWLERS.search.filter((b) => isBotBlocked(robotsParsed, b));
    const blockedTraining = AI_CRAWLERS.training.filter((b) => isBotBlocked(robotsParsed, b));

    // Search bots
    if (blockedSearch.length === 0) {
      checks.push(check('robots.ai_search_bots', 'AI citation/search bots allowed', 'pass', 'critical',
        'None of the citation/search AI crawlers are disallowed.'));
    } else if (blockedSearch.length >= 3) {
      checks.push(check('robots.ai_search_bots', 'AI citation/search bots allowed', 'fail', 'critical',
        `${blockedSearch.length} AI citation crawlers disallowed: ${blockedSearch.join(', ')}.`,
        { value: blockedSearch,
        action: 'If AI citation traffic matters, unblock OAI-SearchBot, PerplexityBot, Claude-SearchBot.' }));
    } else {
      checks.push(check('robots.ai_search_bots', 'AI citation/search bots allowed', 'fail', 'warning',
        `Disallowed: ${blockedSearch.join(', ')}.`,
        { value: blockedSearch, action: 'Review whether blocking AI citation bots is intentional.' }));
    }

    // Training bots — informational (site owner choice)
    checks.push(check('robots.ai_training_bots', 'AI training bot policy defined',
      (blockedTraining.length > 0 || robotsParsed.groups.length > 0) ? 'pass' : 'fail',
      'notice',
      blockedTraining.length
        ? `Disallowed training crawlers: ${blockedTraining.join(', ')}.`
        : 'No training crawlers explicitly disallowed (opt-in by default).',
      { value: blockedTraining,
        action: blockedTraining.length === 0
          ? 'Consider disallowing training bots (GPTBot, ClaudeBot, CCBot) if you do not want your content trained on.'
          : null }));

    checks.push(check('robots.sitemap', 'Sitemap declared in robots.txt',
      robotsParsed.sitemaps.length ? 'pass' : 'fail',
      robotsParsed.sitemaps.length ? 'notice' : 'warning',
      robotsParsed.sitemaps.length
        ? `Sitemap: ${robotsParsed.sitemaps[0]}`
        : 'No Sitemap directive.',
      { action: robotsParsed.sitemaps.length ? null : 'Add "Sitemap: https://…/sitemap.xml".' }));
  } else {
    checks.push(check('robots.ai_search_bots', 'AI citation/search bots allowed', 'fail', 'critical',
      robots && robots.status ? `robots.txt HTTP ${robots.status}.` : 'robots.txt unfetchable.',
      { action: 'Publish robots.txt with explicit AI crawler rules.' }));
    checks.push(check('robots.ai_training_bots', 'AI training bot policy defined', 'skip', 'notice', 'robots.txt unavailable.'));
    checks.push(check('robots.sitemap', 'Sitemap declared in robots.txt', 'skip', 'notice', 'robots.txt unavailable.'));
  }

  // ---- Anti-scraping bot wall ----
  const raw = (ctx.raw.html || '').toLowerCase();
  const botWall =
    raw.includes('just a moment') ||
    raw.includes('attention required! | cloudflare') ||
    raw.includes('enable javascript and cookies to continue') ||
    raw.includes('cf-browser-verification') ||
    raw.includes('__cf_chl_');
  if (botWall) {
    checks.push(check('geo.bot_wall', 'No anti-bot wall on first response', 'fail', 'critical',
      'A Cloudflare-style interstitial was served to the plain HTTP client.',
      { action: 'Allow-list AI/search crawlers so they receive real HTML, not a challenge page.' }));
  } else {
    checks.push(check('geo.bot_wall', 'No anti-bot wall on first response', 'pass', 'critical',
      'No bot challenge detected.'));
  }

  // ---- noai / noimageai meta tags ----
  const doc = ctx.hydratedDoc || ctx.rawDoc;
  if (doc.noai) {
    checks.push(check('geo.noai', 'No AI-training opt-out directives (noai/noimageai)', 'fail', 'warning',
      `AI-training opt-out directives present: ${doc.noaiValue.noai ? `noai=${doc.noaiValue.noai} ` : ''}` +
      `${doc.noaiValue.noimageai ? `noimageai=${doc.noaiValue.noimageai}` : ''}.`,
      { value: doc.noaiValue,
      action: 'These directives may prevent AI indexing. Remove if you want LLM visibility.' }));
  } else {
    checks.push(check('geo.noai', 'No AI-training opt-out directives (noai/noimageai)', 'pass', 'warning',
      'No noai / noimageai meta directives present.'));
  }

  // ---- X-Robots-Tag noai ----
  const xrt = (ctx.raw.headers['x-robots-tag'] || '').toLowerCase();
  if (/noai|noimageai/.test(xrt)) {
    checks.push(check('geo.x_robots_tag_ai', 'No X-Robots-Tag AI opt-out', 'fail', 'warning',
      `X-Robots-Tag includes AI opt-out: ${truncate(xrt, 80)}`,
      { value: xrt, action: 'Remove noai/noimageai from X-Robots-Tag to enable AI indexing.' }));
  } else {
    checks.push(check('geo.x_robots_tag_ai', 'No X-Robots-Tag AI opt-out', 'pass', 'warning',
      'No AI-related X-Robots-Tag directive.'));
  }

  // ---- Live AI bot probe ----
  if (options.probe && aiProbe) {
    if (aiProbe.status === 0) {
      checks.push(check('geo.ai_probe', 'GPTBot can fetch the page', 'fail', 'critical',
        `Request as GPTBot failed: ${aiProbe.error}`,
        { action: 'Verify firewall/WAF rules do not drop AI crawler user agents.' }));
    } else if (aiProbe.status === 403 || aiProbe.status === 429) {
      checks.push(check('geo.ai_probe', 'GPTBot can fetch the page', 'fail', 'critical',
        `HTTP ${aiProbe.status} for GPTBot.`,
        { action: 'Allow GPTBot in WAF/CDN rules for AI citation traffic.' }));
    } else if (aiProbe.status >= 200 && aiProbe.status < 300) {
      checks.push(check('geo.ai_probe', 'GPTBot can fetch the page', 'pass', 'critical',
        `HTTP ${aiProbe.status}.`, { value: aiProbe.status }));
    } else {
      checks.push(check('geo.ai_probe', 'GPTBot can fetch the page', 'fail', 'warning',
        `Unexpected HTTP ${aiProbe.status}.`, { value: aiProbe.status }));
    }
  } else {
    checks.push(check('geo.ai_probe', 'GPTBot can fetch the page', 'skip', 'info',
      'Not requested (use --probe-ai-bots).'));
  }

  // ---- LLM chunkability ----
  const chunkSignals = [doc.hasFAQ, doc.hasLists, doc.hasTables].filter(Boolean).length;
  if (chunkSignals >= 2) {
    checks.push(check('geo.chunkability', 'Content is LLM-chunkable (lists/tables/FAQ)', 'pass', 'notice',
      `${chunkSignals}/3 structured signals (FAQ: ${doc.hasFAQ}, lists: ${doc.hasLists}, tables: ${doc.hasTables}).`));
  } else {
    checks.push(check('geo.chunkability', 'Content is LLM-chunkable (lists/tables/FAQ)', 'fail', 'notice',
      `Only ${chunkSignals}/3 structured signals.`,
      { action: 'Add FAQ blocks, bulleted lists and comparison tables for AI extractability.' }));
  }

  return buildModule('geo_ai_validator', checks, {
    llms_txt: llms ? { status: llms.status, bytes: llms.bytes, url: llms.url } : null,
    llms_full_txt: llmsFull ? { status: llmsFull.status, bytes: llmsFull.bytes, url: llmsFull.url } : null,
    noai: doc.noaiValue,
    ai_crawler_policy: robotsParsed
      ? Object.fromEntries(AI_CRAWLERS.all.map((b) => [b, isBotBlocked(robotsParsed, b) ? 'disallowed' : 'allowed']))
      : null
  });
}

/* ============================================================================
 * 11. ENGINE 3 — JS RENDERING & HYDRATION
 * ==========================================================================*/

function engineRenderDiff(ctx) {
  const checks = [];
  const { rawDoc, hydratedDoc, headless, raw } = ctx;

  if (!headless || !headless.available || !headless.html) {
    checks.push(check('diff.available', 'Headless DOM comparison available', 'skip', 'info',
      `Headless fetch unavailable: ${headless ? headless.error : 'not run'}.`,
      { action: 'Install Playwright (npm i playwright && npx playwright install chromium).' }));
    return buildModule('js_render_diff', checks, {
      available: false, reason: headless ? headless.error : 'not run'
    });
  }

  const rawWords = rawDoc.wordCount;
  const hydWords = hydratedDoc.wordCount;
  const delta = hydWords - rawWords;
  const rawShare = hydWords > 0 ? rawWords / hydWords : 1;
  const rawInternalLinks = rawDoc.links.filter((l) => l.internal).length;
  const hydInternalLinks = hydratedDoc.links.filter((l) => l.internal).length;
  const rawH1 = rawDoc.h1s.length;
  const hydH1 = hydratedDoc.h1s.length;
  const rawHeadings = rawDoc.headings.length;
  const hydHeadings = hydratedDoc.headings.length;

  // ---- SPA shell detection ----
  const rawBodyText = rawDoc.text.trim();
  const rawNodeCount = rawDoc.nodeCount;
  const isSpaShell = (rawBodyText.length < 120 || rawWords < 20) && rawNodeCount < 60 && hydWords > 150;
  if (isSpaShell) {
    checks.push(check('diff.spa_shell', 'Page has SSR content (not an empty SPA shell)', 'fail', 'critical',
      `Raw HTML is essentially empty (${rawWords} words, ${rawNodeCount} nodes) but hydrated DOM has ${hydWords} words.`,
      { action: 'Implement SSR/SSG or prerender the primary content.' }));
  } else {
    checks.push(check('diff.spa_shell', 'Page has SSR content (not an empty SPA shell)', 'pass', 'critical',
      `Raw HTML contains ${rawWords} words / ${rawNodeCount} nodes.`, { value: rawWords }));
  }

  // ---- Word/content diff ----
  if (hydWords > 50 && rawShare < 0.25) {
    checks.push(check('diff.content', 'Primary content present in raw HTML', 'fail', 'critical',
      `Raw HTML has ${rawWords} words vs ${hydWords} hydrated (${Math.round(rawShare * 100)}% client-rendered).`,
      { value: Math.round(rawShare * 100),
      action: 'Server-render primary content; crawlers may index an empty page.' }));
  } else if (delta > 100) {
    checks.push(check('diff.content', 'Primary content present in raw HTML', 'fail', 'warning',
      `Hydration adds ${delta} words (${rawWords} → ${hydWords}).`,
      { value: delta, action: 'Server-render above-the-fold content.' }));
  } else {
    checks.push(check('diff.content', 'Primary content present in raw HTML', 'pass', 'critical',
      `Raw ${rawWords} words → hydrated ${hydWords} (delta ${delta >= 0 ? '+' : ''}${delta}).`,
      { value: delta }));
  }

  // ---- Critical tag consistency ----
  const critical = ['title', 'canonical', 'metaRobots', 'h1'];
  const mismatches = [];
  if (rawDoc.title !== hydratedDoc.title) mismatches.push('title');
  if ((rawDoc.canonicalAbs || '') !== (hydratedDoc.canonicalAbs || '')) mismatches.push('canonical');
  if (rawDoc.metaRobots !== hydratedDoc.metaRobots) mismatches.push('meta robots');
  if (rawH1 !== hydH1) mismatches.push(`H1 count (${rawH1} → ${hydH1})`);
  if (rawDoc.metaDescription !== hydratedDoc.metaDescription) mismatches.push('meta description');
  if (mismatches.length) {
    checks.push(check('diff.critical_tags', 'Critical tags stable across renders', 'fail', 'critical',
      `JS mutates: ${mismatches.join(', ')}. Crawlers may see the pre-hydration values.`,
      { value: mismatches,
      action: 'Render title/canonical/robots/H1 server-side and avoid client-side mutation.' }));
  } else {
    checks.push(check('diff.critical_tags', 'Critical tags stable across renders', 'pass', 'critical',
      'Title, description, canonical, robots and H1 identical in both renders.'));
  }

  // ---- Internal link crawlability ----
  if (hydInternalLinks > 5 && rawInternalLinks < 3) {
    checks.push(check('diff.links', 'Internal links crawlable without JS', 'fail', 'critical',
      `Only ${rawInternalLinks} internal links raw vs ${hydInternalLinks} hydrated.`,
      { action: 'Render navigation and content links server-side as real <a href>.' }));
  } else if (hydInternalLinks - rawInternalLinks > 20) {
    checks.push(check('diff.links', 'Internal links crawlable without JS', 'fail', 'warning',
      `Hydration adds ${hydInternalLinks - rawInternalLinks} internal links.`,
      { action: 'Server-render primary navigation.' }));
  } else {
    checks.push(check('diff.links', 'Internal links crawlable without JS', 'pass', 'critical',
      `${rawInternalLinks} raw / ${hydInternalLinks} hydrated.`,
      { value: hydInternalLinks - rawInternalLinks }));
  }

  // ---- Headings hydration ----
  if (hydHeadings > 0 && rawHeadings === 0) {
    checks.push(check('diff.headings', 'Headings available without JS', 'fail', 'warning',
      `All ${hydHeadings} headings are injected by JS.`,
      { action: 'Server-render the heading outline.' }));
  } else {
    checks.push(check('diff.headings', 'Headings available without JS', 'pass', 'warning',
      `${rawHeadings} raw / ${hydHeadings} hydrated.`, { value: hydHeadings - rawHeadings }));
  }

  // ---- Payload growth ----
  const rawBytes = rawDoc.htmlBytes;
  const hydBytes = hydratedDoc.htmlBytes;
  const growth = rawBytes > 0 ? hydBytes / rawBytes : 1;
  if (growth > 3 && hydBytes - rawBytes > 100000) {
    checks.push(check('diff.payload', 'DOM growth after hydration reasonable', 'fail', 'warning',
      `Hydrated DOM is ${growth.toFixed(1)}× larger (${fmtBytes(rawBytes)} → ${fmtBytes(hydBytes)}).`,
      { value: Math.round(growth * 100) / 100,
      action: 'Reduce client-side DOM injection; virtualise long lists.' }));
  } else {
    checks.push(check('diff.payload', 'DOM growth after hydration reasonable', 'pass', 'warning',
      `DOM growth ${growth.toFixed(2)}× (${fmtBytes(rawBytes)} → ${fmtBytes(hydBytes)}).`,
      { value: Math.round(growth * 100) / 100 }));
  }

  // ---- Noscript ----
  if (!rawDoc.hasNoscript && hydWords > 200) {
    checks.push(check('diff.noscript', '<noscript> fallback provided', 'fail', 'notice',
      'No <noscript> fallback on a JS-dependent page.',
      { action: 'Add a <noscript> block with essential content and navigation.' }));
  } else {
    checks.push(check('diff.noscript', '<noscript> fallback provided', 'pass', 'notice',
      rawDoc.hasNoscript ? '<noscript> present.' : 'Page does not require noscript fallback.'));
  }

  // ---- JS runtime errors ----
  const errCount = (headless.consoleErrors || []).length;
  if (errCount > 0) {
    checks.push(check('diff.js_errors', 'No JS runtime errors during hydration',
      'fail', errCount > 5 ? 'critical' : 'warning',
      `${errCount} JavaScript error(s) captured.`,
      { value: errCount, action: 'Fix client-side exceptions that may abort hydration.' }));
  } else {
    checks.push(check('diff.js_errors', 'No JS runtime errors during hydration', 'pass', 'warning',
      'No JavaScript errors captured.'));
  }

  // ---- Redirect trace ----
  const redirects = (headless.redirects || []).filter((u, i, arr) => i === 0 || u !== arr[i - 1]);
  if (redirects.length > 3) {
    checks.push(check('diff.redirect_chain', 'Redirect chain ≤ 2 hops', 'fail', 'warning',
      `${redirects.length - 1} redirect hops in headless navigation.`,
      { value: redirects.length - 1,
      action: 'Flatten redirects; each hop wastes crawl budget and TTFB.' }));
  } else {
    checks.push(check('diff.redirect_chain', 'Redirect chain ≤ 2 hops', 'pass', 'warning',
      `${Math.max(0, redirects.length - 1)} redirect hops.`,
      { value: Math.max(0, redirects.length - 1) }));
  }

  return buildModule('js_render_diff', checks, {
    available: true,
    raw_words: rawWords, hydrated_words: hydWords, word_delta: delta,
    raw_share_pct: Math.round(rawShare * 100),
    raw_internal_links: rawInternalLinks, hydrated_internal_links: hydInternalLinks,
    raw_headings: rawHeadings, hydrated_headings: hydHeadings,
    raw_bytes: rawBytes, hydrated_bytes: hydBytes,
    console_errors: headless.consoleErrors || [],
    redirects,
    ttfb_ms: raw.timing.ttfb_ms,
    dom_load_ms: headless.domLoadMs
  });
}

/* ============================================================================
 * 12. ENGINE 4 — DOM ARCHITECTURE & HEADINGS
 * ==========================================================================*/

function engineDomHeadings(ctx) {
  const doc = ctx.hydratedDoc || ctx.rawDoc;
  const checks = [];

  // ---- Node count ----
  const nodes = doc.nodeCount;
  if (nodes > 3000) {
    checks.push(check('dom.node_count', 'DOM node count under 1500', 'fail', 'critical',
      `${nodes} nodes — well above 1500.`,
      { value: nodes, action: 'Simplify markup, remove wrapper divs, virtualise lists.' }));
  } else if (nodes > 1500) {
    checks.push(check('dom.node_count', 'DOM node count under 1500', 'fail', 'warning',
      `${nodes} nodes — above 1500 target.`, { value: nodes,
      action: 'Reduce DOM depth and node count.' }));
  } else {
    checks.push(check('dom.node_count', 'DOM node count under 1500', 'pass', 'warning',
      `${nodes} nodes.`, { value: nodes }));
  }

  // ---- Depth ----
  const depth = doc.maxDepth;
  if (depth > 32) {
    checks.push(check('dom.depth', 'DOM depth under 32 levels', 'fail', 'warning',
      `Depth is ${depth} levels.`, { value: depth,
      action: 'Flatten deeply nested containers; aim for ≤ 32.' }));
  } else {
    checks.push(check('dom.depth', 'DOM depth under 32 levels', 'pass', 'warning',
      `Depth is ${depth} levels.`, { value: depth }));
  }

  // ---- Landmarks ----
  const s = doc.semantic;
  const landmarks = ['main', 'nav', 'header', 'footer'].filter((t) => s[t] > 0);
  if (landmarks.length >= 3) {
    checks.push(check('dom.landmarks', 'Semantic landmark elements', 'pass', 'warning',
      `Found: ${landmarks.join(', ')}.`, { value: landmarks }));
  } else {
    checks.push(check('dom.landmarks', 'Semantic landmark elements', 'fail', 'warning',
      `Only ${landmarks.length}/4 landmarks (${landmarks.join(', ') || 'none'}).`,
      { action: 'Use <header>, <nav>, <main>, <footer>.' }));
  }

  // ---- main uniqueness ----
  if (s.main === 0) {
    checks.push(check('dom.main', 'Exactly one <main> landmark', 'fail', 'warning',
      'No <main> element.', { action: 'Wrap primary content in a single <main>.' }));
  } else if (s.main > 1) {
    checks.push(check('dom.main', 'Exactly one <main> landmark', 'fail', 'warning',
      `${s.main} <main> elements.`, { action: 'Keep exactly one <main>.' }));
  } else {
    checks.push(check('dom.main', 'Exactly one <main> landmark', 'pass', 'warning',
      'One <main> element present.'));
  }

  // ---- article / semantic richness ----
  const richSignals = [s.article > 0, s.section > 0, s.figure > 0, s.time > 0].filter(Boolean).length;
  if (richSignals >= 2) {
    checks.push(check('dom.semantic_rich', 'Semantic HTML richness', 'pass', 'notice',
      `${richSignals}/4 rich semantic elements used.`));
  } else {
    checks.push(check('dom.semantic_rich', 'Semantic HTML richness', 'fail', 'notice',
      `Only ${richSignals}/4 rich semantic elements (article/section/figure/time).`,
      { action: 'Use <article>, <section>, <figure>, <time> to express meaning.' }));
  }

  // ---- Duplicate IDs ----
  if (doc.duplicateIds.length) {
    checks.push(check('dom.duplicate_ids', 'No duplicate element IDs', 'fail', 'warning',
      `${doc.duplicateIds.length} duplicate ID(s): ${doc.duplicateIds.slice(0, 5).map((d) => d.id).join(', ')}.`,
      { value: doc.duplicateIds.length,
      action: 'Ensure every id attribute is unique.' }));
  } else {
    checks.push(check('dom.duplicate_ids', 'No duplicate element IDs', 'pass', 'warning',
      'All IDs are unique.'));
  }

  // ---- Heading structure ----
  const h1Count = doc.h1s.length;
  if (h1Count === 0) {
    checks.push(check('headings.h1', 'One H1 present', 'fail', 'critical',
      'No H1.', { action: 'Add a single descriptive H1.' }));
  } else if (h1Count > 1) {
    checks.push(check('headings.h1', 'One H1 present', 'fail', 'warning',
      `${h1Count} H1s.`, { value: h1Count, action: 'Consolidate to a single H1.' }));
  } else {
    checks.push(check('headings.h1', 'One H1 present', 'pass', 'critical', 'One H1 present.'));
  }

  // ---- Text-to-HTML ratio ----
  const ratio = doc.textToHtmlRatio;
  if (ratio < 5) {
    checks.push(check('dom.text_html_ratio', 'Text-to-HTML ratio ≥ 10%', 'fail', 'warning',
      `${ratio}% text — heavy markup or thin content.`,
      { value: ratio, action: 'Reduce inline code, remove redundant wrappers, expand content.' }));
  } else if (ratio < 10) {
    checks.push(check('dom.text_html_ratio', 'Text-to-HTML ratio ≥ 10%', 'fail', 'notice',
      `${ratio}% text — below 10% target.`, { value: ratio,
      action: 'Aim for ≥ 10% text-to-HTML ratio.' }));
  } else {
    checks.push(check('dom.text_html_ratio', 'Text-to-HTML ratio ≥ 10%', 'pass', 'notice',
      `${ratio}% text.`, { value: ratio }));
  }

  // ---- Word count (thin content) ----
  const wc = doc.wordCount;
  if (wc < 200) {
    checks.push(check('dom.word_count', 'Word count ≥ 300', 'fail', 'warning',
      `${wc} words — thin content.`,
      { value: wc, action: 'Expand content or consolidate with a related page.' }));
  } else if (wc < 300) {
    checks.push(check('dom.word_count', 'Word count ≥ 300', 'fail', 'notice',
      `${wc} words — borderline thin.`, { value: wc, action: 'Aim for ≥ 300 words of unique content.' }));
  } else {
    checks.push(check('dom.word_count', 'Word count ≥ 300', 'pass', 'notice',
      `${wc} words.`, { value: wc }));
  }

  // ---- Iframe dimensions ----
  const iframesMissingDims = doc.iframes.filter((i) => !i.hasDims).length;
  if (doc.iframes.length && iframesMissingDims > 0) {
    checks.push(check('dom.iframe_dims', '<iframe> has width & height', 'fail', 'warning',
      `${iframesMissingDims}/${doc.iframes.length} iframes lack width/height (CLS risk).`,
      { value: iframesMissingDims, action: 'Add width and height to every <iframe>.' }));
  } else if (doc.iframes.length) {
    checks.push(check('dom.iframe_dims', '<iframe> has width & height', 'pass', 'warning',
      `All ${doc.iframes.length} iframes declare dimensions.`));
  } else {
    checks.push(check('dom.iframe_dims', '<iframe> has width & height', 'skip', 'notice', 'No iframes.'));
  }

  return buildModule('dom_headings', checks, {
    node_count: nodes, max_depth: depth, semantic: s,
    duplicate_ids: doc.duplicateIds, word_count: wc, text_to_html_ratio: ratio,
    h1_count: h1Count, heading_count: doc.headings.length
  });
}

/* ============================================================================
 * 13. ENGINE 5 — DEEP LINK & NAVIGATION
 * ==========================================================================*/

async function engineLinkNavigation(ctx) {
  const doc = ctx.hydratedDoc || ctx.rawDoc;
  const checks = [];
  const links = doc.links;

  const internal = links.filter((l) => l.internal && !l.isAnchor);
  const external = links.filter((l) => !l.internal && !l.isAnchor && !l.isProtocolRelative && l.resolved);
  const anchors = links.filter((l) => l.isAnchor);
  const protocolRel = links.filter((l) => l.isProtocolRelative);

  checks.push(check('links.inventory', 'Link inventory classified', 'pass', 'info',
    `${internal.length} internal, ${external.length} external, ${anchors.length} in-page, ` +
    `${protocolRel.length} protocol-relative.`,
    { value: { internal: internal.length, external: external.length, anchors: anchors.length, protocolRel: protocolRel.length } }));

  // ---- Internal link count ----
  if (internal.length < 3) {
    checks.push(check('links.internal', 'Sufficient internal links (≥ 5)', 'fail', 'warning',
      `Only ${internal.length} internal links.`,
      { value: internal.length, action: 'Add contextual internal links to key pages.' }));
  } else if (internal.length < 5) {
    checks.push(check('links.internal', 'Sufficient internal links (≥ 5)', 'fail', 'notice',
      `${internal.length} internal links — aim for ≥ 5.`, { value: internal.length,
      action: 'Add more internal links.' }));
  } else {
    checks.push(check('links.internal', 'Sufficient internal links (≥ 5)', 'pass', 'notice',
      `${internal.length} internal links.`, { value: internal.length }));
  }

  // ---- Generic anchor text ----
  const genericRe = /^(click here|here|read more|learn more|more|this|link|website|http\S*)$/i;
  const generic = links.filter((l) => genericRe.test((l.text || '').trim()));
  if (generic.length) {
    checks.push(check('links.anchor_text', 'No generic anchor text', 'fail', 'warning',
      `${generic.length} generic anchors: ${generic.slice(0, 5).map((l) => `"${l.text}"`).join(', ')}.`,
      { value: generic.length,
      action: 'Replace generic anchors with descriptive text.' }));
  } else {
    checks.push(check('links.anchor_text', 'No generic anchor text', 'pass', 'warning',
      'No generic anchor text detected.'));
  }

  // ---- Naked URLs as anchor ----
  const naked = links.filter((l) => /^https?:\/\//i.test((l.text || '').trim()));
  if (naked.length > links.length * 0.5 && links.length > 5) {
    checks.push(check('links.naked_urls', 'Anchor text is descriptive (not naked URLs)', 'fail', 'notice',
      `${naked.length}/${links.length} links use the URL as anchor text.`,
      { value: naked.length, action: 'Replace naked URLs with descriptive anchor text.' }));
  } else {
    checks.push(check('links.naked_urls', 'Anchor text is descriptive (not naked URLs)', 'pass', 'notice',
      `${naked.length}/${links.length} naked URL anchors.`, { value: naked.length }));
  }

  // ---- target="_blank" without rel=noopener ----
  const blankNoopener = links.filter((l) =>
    l.target === '_blank' && !/noopener/.test(l.rel));
  if (blankNoopener.length) {
    checks.push(check('links.noopener', 'target="_blank" includes rel="noopener"', 'fail', 'warning',
      `${blankNoopener.length} link(s) open in a new tab without rel="noopener".`,
      { value: blankNoopener.length,
      action: 'Add rel="noopener" (and usually "noreferrer") to all target="_blank" links.' }));
  } else {
    checks.push(check('links.noopener', 'target="_blank" includes rel="noopener"', 'pass', 'warning',
      'All target="_blank" links include rel="noopener" or none exist.'));
  }

  // ---- rel attributes ----
  const nofollow = links.filter((l) => /nofollow/.test(l.rel)).length;
  const sponsored = links.filter((l) => /sponsored/.test(l.rel)).length;
  const ugc = links.filter((l) => /ugc/.test(l.rel)).length;
  checks.push(check('links.rel', 'Link rel attributes audited', 'pass', 'info',
    `nofollow: ${nofollow}, sponsored: ${sponsored}, ugc: ${ugc}.`,
    { value: { nofollow, sponsored, ugc } }));

  // ---- External link reachability ----
  if (ctx.options.external && external.length) {
    const sample = external.slice(0, MAX_EXT_LINKS);
    const results = [];
    for (let i = 0; i < sample.length; i += EXT_LINK_CONCURRENCY) {
      const batch = sample.slice(i, i + EXT_LINK_CONCURRENCY);
      const batchRes = await Promise.all(batch.map((l) => headCheck(l.resolved, ctx.options)));
      results.push(...batchRes);
    }
    const broken = results.filter((r) => !r.ok || r.status >= 400);
    if (broken.length) {
      checks.push(check('links.broken_external', 'External links reachable', 'fail', 'warning',
        `${broken.length}/${results.length} checked external links failed: ` +
        broken.slice(0, 3).map((b) => `${truncate(b.url, 60)} → ${b.status || b.error}`).join('; '),
        { value: broken.length,
        action: 'Fix or remove broken outbound links.' }));
    } else {
      checks.push(check('links.broken_external', 'External links reachable', 'pass', 'warning',
        `All ${results.length} sampled external links returned HTTP 200.`,
        { value: results.length }));
    }
  } else {
    checks.push(check('links.broken_external', 'External links reachable', 'skip', 'notice',
      ctx.options.external ? 'No external links.' : 'Use --check-external-links to enable.'));
  }

  // ---- hrefLang ----
  if (doc.hreflang.length) {
    checks.push(check('links.hreflang', 'hreflang alternates declared', 'pass', 'notice',
      `${doc.hreflang.length} hreflang alternate(s).`, { value: doc.hreflang.length }));
  } else {
    checks.push(check('links.hreflang', 'hreflang alternates declared', 'skip', 'notice',
      'No hreflang alternates (fine for single-language sites).'));
  }

  return buildModule('link_navigation', checks, {
    internal_count: internal.length,
    external_count: external.length,
    anchor_count: anchors.length,
    generic_anchor_count: generic.length,
    nofollow_count: nofollow,
    sponsored_count: sponsored,
    ugc_count: ugc,
    protocol_relative_count: protocolRel.length
  });
}

/* ============================================================================
 * 14. ENGINE 6 — SCHEMA.ORG & RICH RESULTS
 * ==========================================================================*/

const SCHEMA_REQUIRED = {
  Article: ['headline', 'author', 'datePublished'],
  NewsArticle: ['headline', 'author', 'datePublished'],
  BlogPosting: ['headline', 'author', 'datePublished'],
  Product: ['name', 'offers'],
  Organization: ['name', 'url'],
  LocalBusiness: ['name', 'address', 'telephone'],
  FAQPage: ['mainEntity'],
  BreadcrumbList: ['itemListElement'],
  WebSite: ['name', 'url'],
  WebPage: ['name', 'url'],
  Person: ['name'],
  Event: ['name', 'startDate', 'location']
};

function engineSchemaRich(ctx) {
  const doc = ctx.hydratedDoc || ctx.rawDoc;
  const checks = [];

  const blocks = doc.jsonLd;
  const errors = doc.jsonLdErrors;

  if (errors.length) {
    checks.push(check('schema.syntax', 'JSON-LD parses without errors', 'fail', 'critical',
      `${errors.length} malformed JSON-LD block(s).`,
      { value: errors.slice(0, 3),
      action: 'Fix JSON syntax — validated with JSON.parse().' }));
  } else {
    checks.push(check('schema.syntax', 'JSON-LD parses without errors',
      blocks.length ? 'pass' : 'skip',
      'critical',
      blocks.length ? `${blocks.length} JSON-LD block(s) parsed.` : 'No JSON-LD blocks to validate.'));
  }

  if (blocks.length === 0) {
    checks.push(check('schema.present', 'Structured data present', 'fail', 'warning',
      'No JSON-LD or Microdata found.',
      { action: 'Add JSON-LD for the primary entity (Organization, WebPage, Article).' }));
    return buildModule('schema_rich', checks, { types: [], block_count: 0, microdata_items: doc.microdataItems });
  }

  checks.push(check('schema.present', 'Structured data present', 'pass', 'warning',
    `${blocks.length} JSON-LD block(s), ${doc.microdataItems} microdata item(s).`,
    { value: blocks.length }));

  // ---- Flatten all schema nodes ----
  const nodes = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n['@graph']) walk(n['@graph']);
    if (n['@type']) nodes.push(n);
    for (const k of Object.keys(n)) {
      if (k === '@type' || k === '@graph') continue;
      const v = n[k];
      if (v && typeof v === 'object') walk(v);
    }
  };
  blocks.forEach(walk);

  // ---- Type coverage ----
  const types = [...new Set(nodes.map((n) => n['@type']).flat().filter(Boolean))];
  checks.push(check('schema.types', 'Schema types identified', 'pass', 'info',
    types.length ? `Types: ${types.join(', ')}` : 'No @type detected.',
    { value: types }));

  // ---- Primary entity ----
  const primaryTypes = ['Article', 'NewsArticle', 'BlogPosting', 'Product', 'Organization',
                        'LocalBusiness', 'WebSite', 'WebPage', 'FAQPage', 'BreadcrumbList'];
  const hasPrimary = types.some((t) => primaryTypes.includes(t));
  if (hasPrimary) {
    checks.push(check('schema.primary_entity', 'Primary entity schema present', 'pass', 'warning',
      `Primary type(s): ${types.filter((t) => primaryTypes.includes(t)).join(', ')}.`));
  } else {
    checks.push(check('schema.primary_entity', 'Primary entity schema present', 'fail', 'warning',
      `No recognised primary entity type. Found: ${types.join(', ') || 'none'}.`,
      { action: 'Add a primary entity (Organization, WebPage, Article, Product, …).' }));
  }

  // ---- Required fields ----
  const missingRequired = [];
  for (const n of nodes) {
    const t = n['@type'];
    const tList = Array.isArray(t) ? t : [t];
    for (const tt of tList) {
      const reqs = SCHEMA_REQUIRED[tt];
      if (!reqs) continue;
      for (const field of reqs) {
        if (n[field] === undefined || n[field] === null || n[field] === '') {
          missingRequired.push(`${tt}.${field}`);
        }
      }
    }
  }
  if (missingRequired.length) {
    checks.push(check('schema.required_fields', 'Required schema fields present', 'fail', 'warning',
      `Missing: ${missingRequired.slice(0, 8).join(', ')}${missingRequired.length > 8 ? '…' : ''}`,
      { value: missingRequired,
      action: 'Add required properties for each schema type.' }));
  } else {
    checks.push(check('schema.required_fields', 'Required schema fields present', 'pass', 'warning',
      'All required fields present for detected types.'));
  }

  // ---- Entity match verification (visible text) ----
  const bodyLower = doc.text.toLowerCase();
  const mismatches = [];
  for (const n of nodes) {
    const t = n['@type'];
    const tList = Array.isArray(t) ? t : [t];
    if (tList.includes('Article') || tList.includes('NewsArticle') || tList.includes('BlogPosting')) {
      if (n.headline && !bodyLower.includes(String(n.headline).toLowerCase().slice(0, 30))) {
        mismatches.push(`Article.headline not found in visible text`);
      }
    }
    if (tList.includes('Product')) {
      if (n.name && !bodyLower.includes(String(n.name).toLowerCase().slice(0, 20))) {
        mismatches.push('Product.name not found in visible text');
      }
    }
    if (tList.includes('FAQPage') && Array.isArray(n.mainEntity)) {
      const qs = n.mainEntity.map((q) => q && q.name).filter(Boolean);
      const missing = qs.filter((q) => !bodyLower.includes(String(q).toLowerCase().slice(0, 20)));
      if (missing.length) mismatches.push(`${missing.length} FAQ question(s) not in visible text`);
    }
  }
  if (mismatches.length) {
    checks.push(check('schema.entity_match', 'Schema matches visible DOM content', 'fail', 'warning',
      `Mismatches: ${mismatches.slice(0, 3).join('; ')}.`,
      { value: mismatches,
      action: 'Keep structured data consistent with the visible page content (Google requirement).' }));
  } else {
    checks.push(check('schema.entity_match', 'Schema matches visible DOM content', 'pass', 'warning',
      'No obvious mismatches between schema and visible text.'));
  }

  // ---- BreadcrumbList ----
  if (types.includes('BreadcrumbList')) {
    checks.push(check('schema.breadcrumb', 'BreadcrumbList schema present', 'pass', 'notice',
      'Breadcrumb schema found.'));
  } else {
    checks.push(check('schema.breadcrumb', 'BreadcrumbList schema present', 'fail', 'notice',
      'No BreadcrumbList schema.',
      { action: 'Add BreadcrumbList schema for SERP breadcrumb rich results.' }));
  }

  // ---- FAQPage ----
  if (types.includes('FAQPage')) {
    checks.push(check('schema.faq', 'FAQPage schema present', 'pass', 'notice',
      'FAQPage schema found.'));
  } else if (doc.hasFAQ) {
    checks.push(check('schema.faq', 'FAQPage schema present', 'fail', 'notice',
      'FAQ content present but no FAQPage schema.',
      { action: 'Mark up FAQ content with FAQPage schema.' }));
  } else {
    checks.push(check('schema.faq', 'FAQPage schema present', 'skip', 'notice',
      'No FAQ content detected.'));
  }

  return buildModule('schema_rich', checks, {
    block_count: blocks.length,
    microdata_items: doc.microdataItems,
    types,
    node_count: nodes.length,
    errors
  });
}

/* ============================================================================
 * 15. ENGINE 7 — E-E-A-T & TRUST SIGNALS
 * ==========================================================================*/

function engineEeatTrust(ctx) {
  const doc = ctx.hydratedDoc || ctx.rawDoc;
  const checks = [];

  // ---- Author attribution ----
  const hasAuthorMeta = Boolean(doc.authorMeta);
  const hasSchemaAuthor = doc.jsonLdTypes.some((t) => /Person|Author/i.test(t));
  const hasAuthorText = /\b(by|author|written by|reviewed by)\b/i.test(doc.text.slice(0, 2000));
  const authorSignals = [hasAuthorMeta, hasSchemaAuthor, hasAuthorText].filter(Boolean).length;

  if (authorSignals >= 2) {
    checks.push(check('eeat.author', 'Author attribution present', 'pass', 'warning',
      `Signals: meta=${hasAuthorMeta}, schema=${hasSchemaAuthor}, text=${hasAuthorText}.`));
  } else if (authorSignals === 1) {
    checks.push(check('eeat.author', 'Author attribution present', 'fail', 'notice',
      'Only one author signal found.',
      { action: 'Add <meta name="author">, schema.org/Person author and byline text.' }));
  } else {
    checks.push(check('eeat.author', 'Author attribution present', 'fail', 'warning',
      'No author attribution signals.',
      { action: 'Add named author with bio link and Person schema.' }));
  }

  // ---- Publication / modified times ----
  const pub = doc.publishedTime;
  const mod = doc.modifiedTime;
  if (pub) {
    const d = new Date(pub);
    if (!isNaN(d.getTime())) {
      const ageDays = Math.round((Date.now() - d.getTime()) / 86400000);
      checks.push(check('eeat.published_time', 'Publication date present & valid', 'pass', 'notice',
        `Published ${d.toISOString().slice(0, 10)} (${ageDays}d ago).`,
        { value: pub }));
    } else {
      checks.push(check('eeat.published_time', 'Publication date present & valid', 'fail', 'notice',
        `Unparseable published date: ${pub}`,
        { action: 'Use ISO-8601 date format for article:published_time.' }));
    }
  } else {
    checks.push(check('eeat.published_time', 'Publication date present & valid', 'fail', 'notice',
      'No article:published_time / schema datePublished.',
      { action: 'Add article:published_time and schema datePublished for content freshness signals.' }));
  }

  if (mod) {
    const d = new Date(mod);
    checks.push(check('eeat.modified_time', 'Modified date present & valid',
      isNaN(d.getTime()) ? 'fail' : 'pass', 'notice',
      isNaN(d.getTime()) ? `Unparseable modified date: ${mod}` : `Modified ${d.toISOString().slice(0, 10)}.`,
      { value: mod }));
  } else {
    checks.push(check('eeat.modified_time', 'Modified date present & valid', 'fail', 'notice',
      'No article:modified_time / schema dateModified.',
      { action: 'Add article:modified_time when content updates.' }));
  }

  // ---- Trust / legal page links ----
  const trustRe = {
    about: /\/(about|about-us|company|team)(\/|$|\?)/i,
    contact: /\/(contact|contact-us|support|help)(\/|$|\?)/i,
    privacy: /\/(privacy|privacy-policy|legal)(\/|$|\?)/i,
    terms: /\/(terms|terms-of-service|tos|tos-of-service|legal\/terms)(\/|$|\?)/i
  };
  const trustFound = {};
  for (const [k, re] of Object.entries(trustRe)) {
    trustFound[k] = doc.links.some((l) => l.resolved && re.test(l.resolved));
  }
  const trustCount = Object.values(trustFound).filter(Boolean).length;

  if (trustCount >= 3) {
    checks.push(check('eeat.trust_links', 'Trust & legal pages linked', 'pass', 'warning',
      `Found: ${Object.entries(trustFound).filter(([, v]) => v).map(([k]) => k).join(', ')}.`,
      { value: trustFound }));
  } else if (trustCount >= 1) {
    checks.push(check('eeat.trust_links', 'Trust & legal pages linked', 'fail', 'warning',
      `Only ${trustCount}/4 trust pages linked: ${Object.entries(trustFound).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}.`,
      { value: trustFound,
      action: 'Link Privacy Policy, Terms, About and Contact from the footer.' }));
  } else {
    checks.push(check('eeat.trust_links', 'Trust & legal pages linked', 'fail', 'critical',
      'No Privacy Policy, Terms, About or Contact link found.',
      { value: trustFound,
      action: 'Add visible links to About, Contact, Privacy Policy and Terms.' }));
  }

  // ---- HTTPS ----
  let protocol = null;
  try { protocol = new URL(ctx.raw.finalUrl).protocol; } catch { /* ignore */ }
  if (protocol === 'https:') {
    checks.push(check('eeat.https', 'Site served over HTTPS', 'pass', 'critical',
      `Final URL uses HTTPS.`));
  } else {
    checks.push(check('eeat.https', 'Site served over HTTPS', 'fail', 'critical',
      `Final URL is ${protocol || 'unknown'} — not HTTPS.`,
      { action: 'Serve the entire site over HTTPS.' }));
  }

  // ---- Thin content ----
  const wc = doc.wordCount;
  if (wc < 200) {
    checks.push(check('eeat.thin_content', 'Content is not thin (≥ 300 words)', 'fail', 'warning',
      `${wc} words.`, { value: wc,
      action: 'Expand content or consolidate with related pages.' }));
  } else if (wc < 300) {
    checks.push(check('eeat.thin_content', 'Content is not thin (≥ 300 words)', 'fail', 'notice',
      `${wc} words — borderline.`, { value: wc, action: 'Aim for ≥ 300 words.' }));
  } else {
    checks.push(check('eeat.thin_content', 'Content is not thin (≥ 300 words)', 'pass', 'notice',
      `${wc} words.`, { value: wc }));
  }

  // ---- Content-required signals for transactional pages ----
  const hasContactInfo = /\b(\+?\d[\d\s().-]{7,}|@[a-z0-9.-]+\.[a-z]{2,})\b/i.test(doc.text);
  if (hasContactInfo) {
    checks.push(check('eeat.contact_info', 'Contact information visible on page', 'pass', 'notice',
      'Phone or email address found in body text.'));
  } else {
    checks.push(check('eeat.contact_info', 'Contact information visible on page', 'skip', 'notice',
      'No phone/email in body (acceptable for non-commercial content).'));
  }

  return buildModule('eeat_trust', checks, {
    author_signals: { meta: hasAuthorMeta, schema: hasSchemaAuthor, text: hasAuthorText },
    published_time: pub, modified_time: mod,
    trust_links: trustFound, https: protocol === 'https:',
    word_count: wc
  });
}

/* ============================================================================
 * 16. ENGINE 8 — SERVER RULES, PROTOCOL & SECURITY
 * ==========================================================================*/

function engineServerSecurity(ctx) {
  const checks = [];
  const raw = ctx.raw;
  const h = raw.headers;

  // ---- HTTP status ----
  if (raw.status >= 200 && raw.status < 300) {
    checks.push(check('server.status', 'HTTP status 2xx', 'pass', 'critical',
      `HTTP ${raw.status}.`, { value: raw.status }));
  } else if (raw.status >= 300 && raw.status < 400) {
    checks.push(check('server.status', 'HTTP status 2xx', 'fail', 'warning',
      `HTTP ${raw.status} — fetch did not follow the redirect.`, { value: raw.status,
      action: 'Investigate redirect handling.' }));
  } else {
    checks.push(check('server.status', 'HTTP status 2xx', 'fail', 'critical',
      `HTTP ${raw.status} — page unreachable for crawlers.`, { value: raw.status,
      action: 'Return HTTP 200 for indexable pages.' }));
  }

  // ---- TTFB ----
  const ttfb = raw.timing.ttfb_ms;
  if (ttfb < 800) {
    checks.push(check('server.ttfb', 'TTFB < 800ms', 'pass', 'warning',
      `TTFB ${ttfb}ms.`, { value: ttfb }));
  } else if (ttfb < 1800) {
    checks.push(check('server.ttfb', 'TTFB < 800ms', 'fail', 'warning',
      `TTFB ${ttfb}ms — server is slow.`, { value: ttfb,
      action: 'Add caching / CDN / edge rendering to reduce TTFB.' }));
  } else {
    checks.push(check('server.ttfb', 'TTFB < 800ms', 'fail', 'critical',
      `TTFB ${ttfb}ms — severely slow.`, { value: ttfb,
      action: 'Investigate origin latency; add full-page caching.' }));
  }

  // ---- X-Robots-Tag ----
  const xrt = h['x-robots-tag'] || '';
  if (/noindex/i.test(xrt)) {
    checks.push(check('server.x_robots_tag', 'X-Robots-Tag permits indexing', 'fail', 'critical',
      `X-Robots-Tag contains noindex: "${truncate(xrt, 80)}"`,
      { value: xrt, action: 'Remove noindex from X-Robots-Tag for pages that should rank.' }));
  } else {
    checks.push(check('server.x_robots_tag', 'X-Robots-Tag permits indexing', 'pass', 'critical',
      xrt ? `X-Robots-Tag: ${truncate(xrt, 60)}` : 'No X-Robots-Tag.', { value: xrt || null }));
  }

  // ---- Link header canonical ----
  const linkHeader = h['link'] || '';
  const linkCanonical = /rel="?canonical"?/i.test(linkHeader);
  if (linkCanonical && !ctx.rawDoc.canonical) {
    checks.push(check('server.link_canonical', 'Canonical present in HTML or Link header', 'pass', 'notice',
      'Link: rel="canonical" HTTP header found.', { value: linkHeader }));
  } else if (linkCanonical && ctx.rawDoc.canonical) {
    checks.push(check('server.link_canonical', 'Canonical present in HTML or Link header', 'pass', 'notice',
      'Both HTML <link rel="canonical"> and Link header canonical present.'));
  } else {
    checks.push(check('server.link_canonical', 'Canonical present in HTML or Link header', 'skip', 'notice',
      'No HTTP Link canonical header (optional if HTML canonical exists).'));
  }

  // ---- Protocol version ----
  const proto = h[':status'] || h['x-http-version'] || null;
  const altSvc = h['alt-svc'] || '';
  const http3 = /h3/i.test(altSvc);
  if (http3) {
    checks.push(check('server.protocol', 'HTTP/2 or HTTP/3 supported', 'pass', 'notice',
      `HTTP/3 advertised via Alt-Svc.`, { value: 'h3' }));
  } else {
    checks.push(check('server.protocol', 'HTTP/2 or HTTP/3 supported', 'skip', 'notice',
      'Could not verify HTTP/2/3 from response headers.' + (proto ? ` (${proto})` : ''),
      { value: proto }));
  }

  // ---- Compression ----
  const enc = (h['content-encoding'] || '').toLowerCase();
  if (/br|gzip|zstd/.test(enc)) {
    checks.push(check('server.compression', 'Compression enabled (br/gzip/zstd)', 'pass', 'notice',
      `Content-Encoding: ${enc}`, { value: enc }));
  } else {
    checks.push(check('server.compression', 'Compression enabled (br/gzip/zstd)', 'fail', 'notice',
      'No Content-Encoding header.',
      { action: 'Enable Brotli (preferred) or gzip compression.' }));
  }

  // ---- CSP ----
  const csp = h['content-security-policy'] || '';
  if (csp) {
    checks.push(check('server.csp', 'Content-Security-Policy set', 'pass', 'warning',
      `CSP present (${csp.length} bytes).`));
  } else {
    checks.push(check('server.csp', 'Content-Security-Policy set', 'fail', 'notice',
      'No Content-Security-Policy header.',
      { action: 'Add a Content-Security-Policy to mitigate XSS.' }));
  }

  // ---- HSTS ----
  const hsts = h['strict-transport-security'] || '';
  if (/max-age=\d+/.test(hsts)) {
    const maxAge = parseInt(hsts.match(/max-age=(\d+)/i)[1], 10);
    if (maxAge >= 31536000) {
      checks.push(check('server.hsts', 'HSTS with long max-age', 'pass', 'warning',
        `Strict-Transport-Security: ${truncate(hsts, 60)}`, { value: hsts }));
    } else {
      checks.push(check('server.hsts', 'HSTS with long max-age', 'fail', 'notice',
        `HSTS max-age is only ${maxAge}s (< 1 year).`,
        { value: maxAge, action: 'Set Strict-Transport-Security: max-age=31536000; includeSubDomains.' }));
    }
  } else {
    checks.push(check('server.hsts', 'HSTS with long max-age', 'fail', 'warning',
      'No Strict-Transport-Security header.',
      { action: 'Add Strict-Transport-Security: max-age=31536000; includeSubDomains.' }));
  }

  // ---- X-Content-Type-Options ----
  const xcto = h['x-content-type-options'] || '';
  if (/nosniff/i.test(xcto)) {
    checks.push(check('server.xcto', 'X-Content-Type-Options: nosniff', 'pass', 'notice',
      xcto));
  } else {
    checks.push(check('server.xcto', 'X-Content-Type-Options: nosniff', 'fail', 'notice',
      'Missing X-Content-Type-Options: nosniff.',
      { action: 'Add X-Content-Type-Options: nosniff.' }));
  }

  // ---- Referrer-Policy ----
  const refPol = h['referrer-policy'] || '';
  if (refPol) {
    checks.push(check('server.referrer_policy', 'Referrer-Policy set', 'pass', 'notice',
      refPol));
  } else {
    checks.push(check('server.referrer_policy', 'Referrer-Policy set', 'fail', 'notice',
      'No Referrer-Policy header.',
      { action: 'Add Referrer-Policy: strict-origin-when-cross-origin.' }));
  }

  // ---- Permissions-Policy ----
  const permPol = h['permissions-policy'] || '';
  if (permPol) {
    checks.push(check('server.permissions_policy', 'Permissions-Policy set', 'pass', 'notice',
      truncate(permPol, 80)));
  } else {
    checks.push(check('server.permissions_policy', 'Permissions-Policy set', 'fail', 'notice',
      'No Permissions-Policy header.',
      { action: 'Add Permissions-Policy to restrict powerful features.' }));
  }

  // ---- Redirect chain (from raw) ----
  const redirectHops = raw.redirected ? 1 : 0;
  if (redirectHops >= 2) {
    checks.push(check('server.redirect_hops', 'Redirect chain ≤ 1 hop', 'fail', 'notice',
      `${redirectHops} redirect hop(s) in the raw fetch.`,
      { value: redirectHops, action: 'Link directly to the final URL.' }));
  } else {
    checks.push(check('server.redirect_hops', 'Redirect chain ≤ 1 hop', 'pass', 'notice',
      `${redirectHops} redirect hop(s).`, { value: redirectHops }));
  }

  return buildModule('server_security', checks, {
    status: raw.status,
    ttfb_ms: ttfb,
    final_url: raw.finalUrl,
    redirected: raw.redirected,
    headers_seen: Object.keys(h).sort(),
    compression: enc || null,
    hsts: hsts || null,
    csp: csp ? `${csp.length} bytes` : null
  });
}

/* ============================================================================
 * 17. ENGINE 9 — PERFORMANCE & CORE WEB VITALS
 * ==========================================================================*/

function enginePerformanceCwv(ctx) {
  const doc = ctx.hydratedDoc || ctx.rawDoc;
  const rawDoc = ctx.rawDoc;
  const checks = [];

  /* ---------------- LCP candidate identification ---------------- */
  let lcpCandidate = null;
  let lcpType = null;

  // Heuristic 1: explicit preload with fetchpriority
  const preloadHero = rawDoc.images.find((i) => i.fetchpriority === 'high');
  if (preloadHero) { lcpCandidate = preloadHero; lcpType = 'image (fetchpriority=high)'; }

  // Heuristic 2: first content image with srcset or large source
  if (!lcpCandidate) {
    const contentImgs = rawDoc.images.filter((i) => i.src && !/logo|icon|sprite|pixel/i.test(i.src));
    if (contentImgs.length) {
      lcpCandidate = contentImgs[0];
      lcpType = 'image (heuristic: first content image)';
    }
  }

  // Heuristic 3: H1 with large text
  if (!lcpCandidate && rawDoc.h1s.length) {
    lcpCandidate = { text: rawDoc.h1s[0].text, isText: true };
    lcpType = 'text (H1)';
  }

  if (lcpCandidate) {
    checks.push(check('cwv.lcp_candidate', 'LCP candidate identified', 'pass', 'info',
      `${lcpType} — ${truncate(lcpCandidate.src || lcpCandidate.text || '', 80)}.`,
      { value: { type: lcpType, src: lcpCandidate.src || null, text: lcpCandidate.text || null } }));
  } else {
    checks.push(check('cwv.lcp_candidate', 'LCP candidate identified', 'fail', 'notice',
      'Could not identify an obvious LCP element (no preloaded hero, no content image, no H1).',
      { action: 'Ensure a clear hero image or H1 exists for above-the-fold content.' }));
  }

  // ---- LCP image optimisations ----
  if (lcpCandidate && !lcpCandidate.isText) {
    const img = lcpCandidate;
    const hasPreload = rawDoc.preloadImages > 0;
    const hasFetchpriority = img.fetchpriority === 'high';
    const hasLazy = img.loading === 'lazy';

    if (hasFetchpriority) {
      checks.push(check('cwv.lcp_fetchpriority', 'LCP image uses fetchpriority="high"', 'pass', 'warning',
        'LCP image declares fetchpriority="high".'));
    } else if (hasPreload) {
      checks.push(check('cwv.lcp_fetchpriority', 'LCP image uses fetchpriority="high"', 'fail', 'warning',
        `${rawDoc.preloadImages} preload image(s) found but no fetchpriority="high".`,
        { action: 'Add fetchpriority="high" to the LCP image and preload it.' }));
    } else {
      checks.push(check('cwv.lcp_fetchpriority', 'LCP image uses fetchpriority="high"', 'fail', 'warning',
        'No fetchpriority or preload for the LCP image.',
        { action: 'Add <link rel="preload" as="image"> and fetchpriority="high".' }));
    }

    if (hasLazy) {
      checks.push(check('cwv.lcp_lazy', 'LCP image not lazy-loaded', 'fail', 'critical',
        'LCP image uses loading="lazy", which delays LCP.',
        { action: 'Remove loading="lazy" from the LCP image; use eager instead.' }));
    } else {
      checks.push(check('cwv.lcp_lazy', 'LCP image not lazy-loaded', 'pass', 'critical',
        'LCP image does not use loading="lazy".'));
    }
  } else {
    checks.push(check('cwv.lcp_fetchpriority', 'LCP image uses fetchpriority="high"', 'skip', 'notice',
      'LCP candidate is text-based.'));
    checks.push(check('cwv.lcp_lazy', 'LCP image not lazy-loaded', 'skip', 'notice',
      'LCP candidate is text-based.'));
  }

  /* ---------------- CLS risk: missing width/height ---------------- */
  const imgsMissingDims = doc.images.filter((i) =>
    !(i.width || i.hasStyleDims) || !(i.height || i.hasStyleDims) || (!i.width && !i.height && !i.hasStyleDims));
  const realMissingDims = doc.images.filter((i) =>
    !((i.width && i.height) || i.hasStyleDims || i.insidePicture));
  if (doc.images.length && realMissingDims.length) {
    checks.push(check('cwv.image_dims', 'Images declare width & height (CLS)', 'fail', 'warning',
      `${realMissingDims.length}/${doc.images.length} images lack explicit dimensions.`,
      { value: realMissingDims.length,
      action: 'Add width + height (or aspect-ratio via CSS) to every image.' }));
  } else if (doc.images.length) {
    checks.push(check('cwv.image_dims', 'Images declare width & height (CLS)', 'pass', 'warning',
      `All ${doc.images.length} images declare dimensions or are inside <picture>.`));
  } else {
    checks.push(check('cwv.image_dims', 'Images declare width & height (CLS)', 'skip', 'notice',
      'No images found.'));
  }

  // ---- Iframe dims (repeat from engine 4 - yes but from CWV perspective) ----
  const iframeMissing = doc.iframes.filter((f) => !f.hasDims).length;
  if (doc.iframes.length && iframeMissing) {
    checks.push(check('cwv.iframe_dims', 'Iframes declare width & height (CLS)', 'fail', 'warning',
      `${iframeMissing}/${doc.iframes.length} iframes lack dimensions (CLS risk).`,
      { value: iframeMissing, action: 'Add width and height to every <iframe>.' }));
  } else if (doc.iframes.length) {
    checks.push(check('cwv.iframe_dims', 'Iframes declare width & height (CLS)', 'pass', 'warning',
      `All ${doc.iframes.length} iframes declare dimensions.`));
  } else {
    checks.push(check('cwv.iframe_dims', 'Iframes declare width & height (CLS)', 'skip', 'notice',
      'No iframes.'));
  }

  /* ---------------- INP hazards: blocking scripts in <head> ---------------- */
  const blocking = doc.scripts.filter((s) => s.blocking);
  if (blocking.length) {
    checks.push(check('cwv.blocking_scripts', 'No render-blocking <head> scripts', 'fail', 'critical',
      `${blocking.length} render-blocking <script src> in <head> without async/defer.`,
      { value: blocking.length,
      action: 'Add async or defer to every <script src> in <head>.' }));
  } else {
    checks.push(check('cwv.blocking_scripts', 'No render-blocking <head> scripts', 'pass', 'critical',
      'No render-blocking <head> scripts detected.'));
  }

  // ---- Blocking stylesheets ----
  const blockingCss = doc.stylesheets.filter((s) => s.renderBlocking).length;
  if (blockingCss > 3) {
    checks.push(check('cwv.blocking_css', 'Render-blocking CSS under control', 'fail', 'warning',
      `${blockingCss} render-blocking stylesheets.`,
      { value: blockingCss, action: 'Inline critical CSS and defer the rest (media="print" trick).' }));
  } else {
    checks.push(check('cwv.blocking_css', 'Render-blocking CSS under control', 'pass', 'warning',
      `${blockingCss} render-blocking stylesheet(s).`, { value: blockingCss }));
  }

  // ---- Third-party scripts ----
  const thirdPartyScripts = ctx.headless && ctx.headless.resources
    ? ctx.headless.resources.filter((r) => r.initiatorType === 'script' && r.name && !sameOrigin(r.name, ctx.raw.finalUrl))
    : [];
  if (thirdPartyScripts.length > 5) {
    checks.push(check('cwv.third_party_scripts', 'Third-party script count manageable', 'fail', 'warning',
      `${thirdPartyScripts.length} third-party script requests — INP risk.`,
      { value: thirdPartyScripts.length,
      action: 'Audit and remove unused third-party scripts; load them with delay/partytown.' }));
  } else {
    checks.push(check('cwv.third_party_scripts', 'Third-party script count manageable', 'pass', 'warning',
      `${thirdPartyScripts.length} third-party script request(s).`,
      { value: thirdPartyScripts.length }));
  }

  /* ---------------- Image format & size ---------------- */
  const imgSrcs = doc.images.map((i) => i.src).filter(Boolean);
  const legacyFormats = imgSrcs.filter((s) => /\.(png|jpe?g|gif|bmp|tiff?)(\?|#|$)/i.test(s)).length;
  const modernFormats = imgSrcs.filter((s) => /\.(webp|avif)(\?|#|$)/i.test(s)).length;
  const hasPictureOrSrcset = doc.images.some((i) => i.srcset || i.insidePicture);

  if (imgSrcs.length && legacyFormats > 0 && modernFormats === 0 && !hasPictureOrSrcset) {
    checks.push(check('cwv.image_formats', 'Images use next-gen formats', 'fail', 'notice',
      `${legacyFormats} legacy-format image(s), no WebP/AVIF or srcset.`,
      { value: legacyFormats,
      action: 'Serve WebP/AVIF images via <picture> or content negotiation.' }));
  } else if (imgSrcs.length) {
    checks.push(check('cwv.image_formats', 'Images use next-gen formats', 'pass', 'notice',
      `Modern: ${modernFormats}, legacy: ${legacyFormats}, srcset/picture: ${hasPictureOrSrcset}.`));
  } else {
    checks.push(check('cwv.image_formats', 'Images use next-gen formats', 'skip', 'notice',
      'No images.'));
  }

  // ---- Oversize assets ----
  if (ctx.headless && ctx.headless.resources) {
    const large = ctx.headless.resources.filter((r) => r.transferSize > 200 * 1024);
    if (large.length) {
      checks.push(check('cwv.oversize_assets', 'No oversized assets (> 200 KB)', 'fail', 'warning',
        `${large.length} resource(s) > 200 KB: ` +
        large.slice(0, 3).map((l) => `${truncate(l.name.split('/').pop(), 40)} (${fmtBytes(l.transferSize)})`).join(', '),
        { value: large.length, action: 'Compress, resize or lazy-load oversized assets.' }));
    } else {
      checks.push(check('cwv.oversize_assets', 'No oversized assets (> 200 KB)', 'pass', 'warning',
        'No resources larger than 200 KB transferred.'));
    }
  } else {
    checks.push(check('cwv.oversize_assets', 'No oversized assets (> 200 KB)', 'skip', 'notice',
      'Headless resource timings unavailable.'));
  }

  // ---- Inline payload ----
  const inlineTotal = doc.inlineScriptBytes + doc.inlineStyleBytes;
  if (inlineTotal > 100 * 1024) {
    checks.push(check('cwv.inline_payload', 'Inline CSS + JS under 100 KB', 'fail', 'notice',
      `${fmtBytes(inlineTotal)} inlined.`,
      { value: inlineTotal, action: 'Extract inline code into cacheable external files.' }));
  } else {
    checks.push(check('cwv.inline_payload', 'Inline CSS + JS under 100 KB', 'pass', 'notice',
      `${fmtBytes(inlineTotal)} inlined.`, { value: inlineTotal }));
  }

  return buildModule('performance_cwv', checks, {
    lcp_candidate: lcpCandidate ? {
      type: lcpType,
      src: lcpCandidate.src || null,
      text: lcpCandidate.text || null
    } : null,
    blocking_scripts: blocking.length,
    blocking_css: blockingCss,
    images_missing_dims: realMissingDims.length,
    third_party_scripts: thirdPartyScripts.length,
    inline_bytes: inlineTotal,
    preload_images: doc.preloadImages,
    preload_scripts: doc.preloadScripts,
    preconnect: doc.preconnect,
    image_modern_count: modernFormats,
    image_legacy_count: legacyFormats
  });
}

/* ============================================================================
 * 18. ENGINE 10 — SCORING, FIX GENERATOR & REPORTING
 * ==========================================================================*/

function engineScoring(ctx, modules) {
  const checks = [];

  // ---- Weighted overall score ----
  let weightedSum = 0;
  let weightTotal = 0;
  for (const m of Object.values(modules)) {
    weightedSum += m.score * m.weight;
    weightTotal += m.weight;
  }
  const overall = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : 0;

  // ---- Recommendation & fix generation ----
  const recommendations = [];
  let critical = 0, warnings = 0, notices = 0, passes = 0;

  for (const m of Object.values(modules)) {
    for (const c of m.checks) {
      if (c.status === 'pass') { passes++; continue; }
      if (c.status === 'skip') continue;
      if (c.severity === 'critical') critical++;
      else if (c.severity === 'warning') warnings++;
      else notices++;

      recommendations.push({
        id: c.id,
        module: m.label,
        category: m.category,
        severity: c.severity,
        title: c.label,
        description: c.message,
        impact_score: SEVERITY_WEIGHT[c.severity] || 1,
        action_item: c.action || 'Review and remediate.'
      });
    }
  }

  recommendations.sort((a, b) => (b.impact_score - a.impact_score) || a.id.localeCompare(b.id));

  // ---- Fix snippets ----
  const fixSnippets = buildFixSnippets(ctx, modules);

  // ---- Checks in this module ----
  const scoreStatus = overall >= 90 ? 'pass' : overall >= 70 ? 'pass' : overall >= 50 ? 'fail' : 'fail';
  const scoreSeverity = overall >= 70 ? 'notice' : overall >= 50 ? 'warning' : 'critical';
  const grade = overall >= 90 ? 'Excellent' : overall >= 70 ? 'Good' : overall >= 50 ? 'Needs Attention' : 'Critical';
  checks.push(check('scoring.overall', 'Overall health index',
    scoreStatus, scoreSeverity,
    `${overall}/100 — ${grade}. ` +
    `${critical} critical, ${warnings} warnings, ${notices} notices, ${passes} passed.`,
    { value: overall }));

  checks.push(check('scoring.critical_count', 'No critical issues',
    critical === 0 ? 'pass' : 'fail',
    critical === 0 ? 'notice' : 'critical',
    `${critical} critical issue(s) detected.`,
    { value: critical }));

  return {
    module: buildModule('scoring_reporting', checks, {
      overall_score: overall,
      grade,
      critical,
      warnings,
      notices,
      passes,
      fix_snippets: fixSnippets
    }),
    overall_score: overall,
    grade,
    critical,
    warnings,
    notices,
    passes,
    recommendations,
    fix_snippets: fixSnippets
  };
}

function buildFixSnippets(ctx, modules) {
  const doc = ctx.hydratedDoc || ctx.rawDoc;
  const snippets = [];

  const has = (id) => {
    for (const m of Object.values(modules)) {
      for (const c of m.checks) {
        if (c.id === id && c.status === 'fail') return true;
      }
    }
    return false;
  };

  if (has('title.present') || has('title.length')) {
    snippets.push({
      target: '<head>',
      snippet: `<!-- Recommended title (50–60 chars) -->\n<title>Primary Keyword — Brand Name</title>`,
      reason: 'Title missing or outside 50–60 character sweet spot.'
    });
  }

  if (has('meta_description.present') || has('meta_description.length')) {
    snippets.push({
      target: '<head>',
      snippet: `<!-- Recommended meta description (140–160 chars) -->\n<meta name="description" content="Concise summary of the page in 140–160 characters that entices clicks from search results.">`,
      reason: 'Meta description missing or out of range.'
    });
  }

  if (has('canonical.present')) {
    const base = ctx.raw.finalUrl || doc.baseUrl;
    snippets.push({
      target: '<head>',
      snippet: `<!-- Canonical -->\n<link rel="canonical" href="${base}">`,
      reason: 'Missing canonical link.'
    });
  }

  if (has('og.complete')) {
    const base = ctx.raw.finalUrl || doc.baseUrl;
    snippets.push({
      target: '<head>',
      snippet: `<!-- Open Graph -->\n` +
        `<meta property="og:title" content="${truncate(doc.title || 'Page Title', 60)}">\n` +
        `<meta property="og:description" content="${truncate(doc.metaDescription || 'Description', 120)}">\n` +
        `<meta property="og:image" content="${base.replace(/\/$/, '')}/og-image-1200x630.jpg">\n` +
        `<meta property="og:image:width" content="1200">\n` +
        `<meta property="og:image:height" content="630">\n` +
        `<meta property="og:url" content="${base}">\n` +
        `<meta property="og:type" content="website">`,
      reason: 'Incomplete Open Graph tags.'
    });
  }

  if (has('twitter.card')) {
    snippets.push({
      target: '<head>',
      snippet: `<!-- Twitter/X Card -->\n` +
        `<meta name="twitter:card" content="summary_large_image">\n` +
        `<meta name="twitter:title" content="${truncate(doc.title || 'Page Title', 60)}">\n` +
        `<meta name="twitter:description" content="${truncate(doc.metaDescription || 'Description', 120)}">`,
      reason: 'Missing Twitter/X card meta tags.'
    });
  }

  if (has('llms_txt.present') || has('llms_txt.h1') || has('llms_txt.summary')) {
    snippets.push({
      target: '/llms.txt (root)',
      snippet:
`# ${doc.title ? truncate(doc.title, 60) : 'Your Site Name'}

> ${doc.metaDescription ? truncate(doc.metaDescription, 140) : 'A concise description of your site for LLMs.'}

## Key Pages
- [Home](${ctx.raw.finalUrl || doc.baseUrl}): Landing page
- [About](/about): About the organisation
- [Docs](/docs): Product documentation
- [Blog](/blog): Articles and updates

## Optional
- [Full corpus](/llms-full.txt): Expanded markdown corpus`,
      reason: 'Missing or malformed /llms.txt.'
    });
  }

  if (has('favicon.present')) {
    snippets.push({
      target: '<head>',
      snippet: `<!-- Favicon -->\n<link rel="icon" href="/favicon.ico" sizes="any">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
      reason: 'No favicon declared.'
    });
  }

  if (has('schema.present') || has('schema.primary_entity')) {
    const base = ctx.raw.finalUrl || doc.baseUrl;
    snippets.push({
      target: '<head> or <body>',
      snippet: `<script type="application/ld+json">\n${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: doc.title || 'Page Title',
        url: base,
        description: doc.metaDescription || 'Page description.'
      }, null, 2)}\n</script>`,
      reason: 'No JSON-LD structured data.'
    });
  }

  if (has('cwv.lcp_fetchpriority') || has('cwv.lcp_lazy')) {
    snippets.push({
      target: '<head> + hero <img>',
      snippet: `<!-- Preload LCP image and mark it high priority -->\n` +
        `<link rel="preload" as="image" href="/hero.webp" fetchpriority="high">\n` +
        `<!-- On the <img> itself -->\n` +
        `<img src="/hero.webp" width="1200" height="630" alt="Hero" fetchpriority="high" decoding="async">`,
      reason: 'LCP image not prioritised / lazy-loaded / missing dimensions.'
    });
  }

  if (has('cwv.blocking_scripts')) {
    snippets.push({
      target: '<head>',
      snippet: `<!-- Defer non-critical JS -->\n<script src="/app.js" defer></script>\n<!-- For analytics / third-party -->\n<script src="https://cdn.example.com/analytics.js" async></script>`,
      reason: 'Render-blocking synchronous scripts in <head>.'
    });
  }

  if (has('dom.iframe_dims') || has('cwv.iframe_dims')) {
    snippets.push({
      target: '<iframe>',
      snippet: `<iframe src="https://www.youtube.com/embed/..." width="560" height="315" loading="lazy" title="Embedded video"></iframe>`,
      reason: 'Iframe missing width/height (CLS risk).'
    });
  }

  if (has('eeat.trust_links')) {
    snippets.push({
      target: 'Footer markup',
      snippet: `<footer>\n  <nav aria-label="Legal">\n    <a href="/about">About</a>\n    <a href="/contact">Contact</a>\n    <a href="/privacy-policy">Privacy Policy</a>\n    <a href="/terms">Terms of Service</a>\n  </nav>\n</footer>`,
      reason: 'Trust & legal pages not linked from the page.'
    });
  }

  return snippets;
}

/* ============================================================================
 * 19. ORCHESTRATOR
 * ==========================================================================*/

async function runAudit(targetUrl, options) {
  const audit_id = randomUUID();
  const timestamp = new Date().toISOString();

  // ---- Raw HTTP fetch ----
  step('Raw HTTP fetch…');
  const raw = await withTimeout(fetchRaw(targetUrl, options), options.timeout + 5000, 'raw fetch');
  step(`  HTTP ${raw.status} · TTFB ${raw.timing.ttfb_ms}ms · ${fmtBytes(raw.bytes)}`);

  if (raw.status >= 400) {
    log(yellow(`  ⚠ Non-2xx response (${raw.status}); continuing.`));
  }

  // ---- Headless fetch ----
  let headless = { available: false, error: 'skipped', html: null };
  if (options.headless) {
    step('Headless DOM fetch…');
    headless = await fetchHeadless(raw.finalUrl, options);
    if (headless.available && headless.html) {
      step(`  DOM loaded in ${headless.domLoadMs}ms · ${fmtBytes(Buffer.byteLength(headless.html, 'utf8'))}`);
    } else {
      step(`  skipped: ${headless.error || 'unavailable'}`);
    }
  } else {
    step('Headless DOM fetch disabled via --no-headless.');
  }

  // ---- Build docs ----
  const rawDoc = extractDocument(raw.html, raw.finalUrl, 'raw');
  const hydratedDoc = headless.available && headless.html
    ? extractDocument(headless.html, headless.finalUrl || raw.finalUrl, 'hydrated')
    : null;

  // ---- robots.txt & llms.txt ----
  let robots = null, robotsParsed = null, llms = null, llmsFull = null;
  let socialImageHead = null, aiProbe = null;

  if (options.llms) {
    let origin;
    try { origin = new URL(raw.finalUrl).origin; } catch { origin = new URL(targetUrl).origin; }

    step('Fetching robots.txt…');
    robots = await fetchText(origin + '/robots.txt', options);
    if (robots.status === 200) robotsParsed = parseRobotsTxt(robots.text);

    step('Fetching /llms.txt…');
    llms = await fetchText(origin + '/llms.txt', options);
    step('Fetching /llms-full.txt…');
    llmsFull = await fetchText(origin + '/llms-full.txt', options);
  } else {
    robots = { url: '', status: 0, ok: false, text: '', bytes: 0, error: 'skipped' };
    llms = { url: '', status: 0, ok: false, text: '', bytes: 0, error: 'skipped' };
    llmsFull = { url: '', status: 0, ok: false, text: '', bytes: 0, error: 'skipped' };
  }

  // ---- Social image reachability ----
  const socialSrc = hydratedDoc?.og?.image || rawDoc.og.image || hydratedDoc?.twitter?.image || rawDoc.twitter.image;
  if (options.social && socialSrc) {
    step('HEAD-checking social preview image…');
    socialImageHead = await headCheck(socialSrc, options);
  }

  // ---- Live AI bot probe ----
  if (options.probe) {
    step('Probing as GPTBot…');
    aiProbe = await fetchRaw(raw.finalUrl, options,
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.0; +https://openai.com/gptbot');
  }

  // ---- Assemble context ----
  const ctx = {
    url: targetUrl,
    options,
    raw,
    rawDoc,
    headless,
    hydratedDoc,
    robots, robotsParsed, llms, llmsFull,
    socialImageHead, aiProbe
  };

  // ---- Run engines ----
  step('Running 10 audit engines…');
  const modules = {};
  modules.meta_and_social = engineMetaAndSocial(ctx);
  modules.geo_ai_validator = engineGeoValidator(ctx);
  modules.js_render_diff = engineRenderDiff(ctx);
  modules.dom_headings = engineDomHeadings(ctx);
  modules.link_navigation = await engineLinkNavigation(ctx);
  modules.schema_rich = engineSchemaRich(ctx);
  modules.eeat_trust = engineEeatTrust(ctx);
  modules.server_security = engineServerSecurity(ctx);
  modules.performance_cwv = enginePerformanceCwv(ctx);

  // Scoring module needs all previous modules
  const scoring = engineScoring(ctx, modules);
  modules.scoring_reporting = scoring.module;

  // ---- Assemble result ----
  const result = {
    audit_id,
    tool: { name: TOOL, version: VERSION },
    timestamp,
    target_url: targetUrl,
    final_url: raw.finalUrl,
    http_status: raw.status,
    fetch_timing: {
      ttfb_ms: raw.timing.ttfb_ms,
      total_ms: raw.timing.total_ms,
      dom_load_ms: headless.available ? headless.domLoadMs : null,
      headless_available: headless.available
    },
    overall_score: scoring.overall_score,
    grade: scoring.grade,
    summary: {
      critical_errors: scoring.critical,
      warnings: scoring.warnings,
      notices: scoring.notices,
      passed_checks: scoring.passes
    },
    modules,
    recommendations: scoring.recommendations,
    fix_snippets: scoring.fix_snippets
  };

  return result;
}

/* ============================================================================
 * 20. OUTPUT FORMATTERS
 * ==========================================================================*/

function formatText(result) {
  const lines = [];
  const hr = '─'.repeat(72);

  const gradeColor = result.overall_score >= 90 ? green
    : result.overall_score >= 70 ? cyan
    : result.overall_score >= 50 ? yellow
    : red;

  lines.push('');
  lines.push(bold(hr));
  lines.push(bold(`  ${TOOL} v${VERSION} — Audit Report`));
  lines.push(bold(hr));
  lines.push(`  Target      : ${result.target_url}`);
  if (result.final_url !== result.target_url) lines.push(`  Final URL   : ${result.final_url}`);
  lines.push(`  HTTP Status : ${result.http_status}`);
  lines.push(`  TTFB        : ${result.fetch_timing.ttfb_ms}ms`);
  if (result.fetch_timing.headless_available) lines.push(`  DOM Load    : ${result.fetch_timing.dom_load_ms}ms`);
  lines.push(`  Audit ID    : ${gray(result.audit_id)}`);
  lines.push('');

  // ---- Score box ----
  const scorePadded = String(result.overall_score).padStart(3, ' ');
  lines.push(`  ${bold('OVERALL SCORE')}  ${gradeColor(bold(`${scorePadded}/100`))}  ${gradeColor(result.grade)}`);
  lines.push(`  ${red('● Critical: ' + result.summary.critical_errors)}   ` +
             `${yellow('● Warnings: ' + result.summary.warnings)}   ` +
             `${cyan('● Notices: ' + result.summary.notices)}   ` +
             `${green('● Passed: ' + result.summary.passed_checks)}`);
  lines.push('');

  // ---- Module scores ----
  lines.push(bold('  MODULE SCORES'));
  lines.push(gray('  ' + '─'.repeat(70)));
  for (const m of Object.values(result.modules)) {
    if (m.key === 'scoring_reporting') continue;
    const bar = scoreBar(m.score);
    const label = `  ${String(m.weight).padStart(2)}%  ${m.label.padEnd(32)}`;
    lines.push(`${label}${bar}  ${String(m.score).padStart(3)}/100`);
  }
  lines.push('');

  // ---- Top recommendations ----
  if (result.recommendations.length) {
    lines.push(bold('  TOP RECOMMENDATIONS'));
    lines.push(gray('  ' + '─'.repeat(70)));
    const top = result.recommendations.slice(0, 15);
    for (const r of top) {
      const sev = r.severity === 'critical' ? red('[CRIT]')
        : r.severity === 'warning' ? yellow('[WARN]')
        : cyan('[INFO]');
      lines.push(`  ${sev} ${bold(r.title)}`);
      lines.push(`         ${gray('Module:')} ${r.module}  ${gray('·')}  ${gray('Impact:')} ${r.impact_score}/6`);
      lines.push(`         ${wrap(r.description, 66, '         ')}`);
      if (r.action_item) lines.push(`         ${green('→')} ${wrap(r.action_item, 64, '           ')}`);
      lines.push('');
    }
    if (result.recommendations.length > 15) {
      lines.push(gray(`  … and ${result.recommendations.length - 15} more recommendation(s).`));
      lines.push('');
    }
  }

  // ---- Fix snippets ----
  if (result.fix_snippets.length) {
    lines.push(bold('  READY-TO-PASTE FIXES'));
    lines.push(gray('  ' + '─'.repeat(70)));
    for (const f of result.fix_snippets.slice(0, 6)) {
      lines.push(`  ${cyan('▸')} ${bold(f.target)}`);
      lines.push(gray(`    ${f.reason}`));
      for (const line of f.snippet.split('\n')) {
        lines.push(`    ${line}`);
      }
      lines.push('');
    }
  }

  lines.push(gray(hr));
  lines.push('');
  return lines.join('\n');
}

function wrap(text, width, indent) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n' + indent);
}

function scoreBar(score) {
  const filled = Math.round(score / 5);
  const empty = 20 - filled;
  const color = score >= 90 ? green : score >= 70 ? cyan : score >= 50 ? yellow : red;
  return color('█'.repeat(filled)) + gray('░'.repeat(empty));
}

function formatMarkdown(result) {
  const lines = [];
  lines.push(`# ${TOOL} v${VERSION} — Audit Report`);
  lines.push('');
  lines.push(`- **Target:** ${result.target_url}`);
  if (result.final_url !== result.target_url) lines.push(`- **Final URL:** ${result.final_url}`);
  lines.push(`- **HTTP Status:** ${result.http_status}`);
  lines.push(`- **TTFB:** ${result.fetch_timing.ttfb_ms}ms`);
  if (result.fetch_timing.headless_available) lines.push(`- **DOM Load:** ${result.fetch_timing.dom_load_ms}ms`);
  lines.push(`- **Audit ID:** \`${result.audit_id}\``);
  lines.push('');
  lines.push(`## Overall Score: **${result.overall_score}/100** — ${result.grade}`);
  lines.push('');
  lines.push(`| Severity | Count |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 🔴 Critical | ${result.summary.critical_errors} |`);
  lines.push(`| 🟡 Warning | ${result.summary.warnings} |`);
  lines.push(`| 🔵 Notice | ${result.summary.notices} |`);
  lines.push(`| ✅ Passed | ${result.summary.passed_checks} |`);
  lines.push('');

  lines.push(`## Module Scores`);
  lines.push('');
  lines.push(`| # | Module | Weight | Score |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const m of Object.values(result.modules)) {
    if (m.key === 'scoring_reporting') continue;
    lines.push(`| ${MODULE_META[m.key].n} | ${m.label} | ${m.weight}% | ${m.score}/100 |`);
  }
  lines.push('');

  lines.push(`## Recommendations`);
  lines.push('');
  for (const r of result.recommendations.slice(0, 25)) {
    lines.push(`### ${r.severity === 'critical' ? '🔴' : r.severity === 'warning' ? '🟡' : '🔵'} ${r.title}`);
    lines.push('');
    lines.push(`- **Module:** ${r.module}`);
    lines.push(`- **Category:** ${r.category}`);
    lines.push(`- **Severity:** ${r.severity}`);
    lines.push(`- **Impact:** ${r.impact_score}/6`);
    lines.push(`- **Issue:** ${r.description}`);
    if (r.action_item) lines.push(`- **Fix:** ${r.action_item}`);
    lines.push('');
  }
  if (result.recommendations.length > 25) {
    lines.push(`_…and ${result.recommendations.length - 25} more._`);
    lines.push('');
  }

  if (result.fix_snippets.length) {
    lines.push(`## Ready-to-Paste Fixes`);
    lines.push('');
    for (const f of result.fix_snippets) {
      lines.push(`### ${f.target}`);
      lines.push('');
      lines.push(`_${f.reason}_`);
      lines.push('');
      lines.push('```html');
      lines.push(f.snippet);
      lines.push('```');
      lines.push('');
    }
  }
  return lines.join('\n');
}

/* ============================================================================
 * 21. MAIN
 * ==========================================================================*/

async function main() {
  const opts = parseArgs(process.argv);
  QUIET = opts.quiet;

  if (opts.version) { console.log(`${TOOL} v${VERSION}`); return 0; }
  if (opts.help)   { printHelp(); return 0; }
  if (!opts.url)   { printHelp(); return 1; }

  let url;
  try {
    url = normalizeUrl(opts.url);
  } catch (e) {
    console.error(red(`Invalid URL: ${opts.url}`));
    return 1;
  }

  log('');
  log(bold(`${TOOL} v${VERSION}`) + gray('  →  ') + cyan(url));
  log('');

  let result;
  try {
    result = await runAudit(url, opts);
  } catch (err) {
    console.error(red(`\n✖ Audit failed: ${err.message}\n`));
    if (opts.verbose) console.error(err.stack);
    return 1;
  }

  // ---- Render output ----
  let out;
  if (opts.format === 'json') {
    out = JSON.stringify(result, null, 2);
  } else if (opts.format === 'markdown') {
    out = formatMarkdown(result);
  } else {
    out = formatText(result);
  }

  if (opts.out) {
    fs.writeFileSync(opts.out, out, 'utf8');
    log(green(`✓ Report written to ${opts.out}`));
    log('');
  } else {
    process.stdout.write(out);
    if (!out.endsWith('\n')) process.stdout.write('\n');
  }

  // ---- Exit code ----
  if (opts.failUnder !== null && result.overall_score < opts.failUnder) {
    log(red(`✖ Score ${result.overall_score} < --fail-under ${opts.failUnder}`));
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error(red(`\n✖ Fatal: ${err.message}\n`));
    if (process.env.SLICKLAB_DEBUG) console.error(err.stack);
    process.exit(1);
  });