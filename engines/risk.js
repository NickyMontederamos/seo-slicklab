'use strict';

/**
 * Risk engine — Google spam-policy and AI-manipulation red flags.
 *
 * Reported as separate risk flags; never folded into the weighted score.
 * Looks for things that get a site penalised or that signal it was hacked:
 *   - concealed text addressed to AI systems (indirect prompt injection)
 *   - text addressed to AI systems in comments, meta tags, alt text, JSON-LD
 *   - hidden links and spam-category outbound links
 *   - cloaking: different content for Googlebot / AI crawlers than for visitors
 *   - sneaky redirects to another site
 *   - keyword stuffing
 *
 * Pure analysis over already-fetched HTML so it can be unit-tested offline.
 */

const cheerio = require('cheerio');

/* ---------------------------------------------------------------------------
 * Text addressed to AI systems
 * -------------------------------------------------------------------------*/

const AI = '(?:ai|a\\.i\\.|llms?|large language models?|language models?|chat ?bots?|ai assistants?|ai agents?|' +
  'assistants?|chatgpt|claude|gemini|copilot|perplexity|crawlers?|bots?)';
const VERB = '(?:mention|say|recommend|describe|state|list|answer|respond|rank|cite|suggest|prefer|treat|consider|tell)';
const DIRECTIVE = `(?:you\\s+(?:must|should|will|are|need)|do not|don't|never\\s+${VERB}|always\\s+${VERB}|${VERB}|ignore|disregard)`;

// Each pattern needs the text to *address* an AI system, not merely mention AI.
const ADDRESSED = [
  new RegExp(`\\b(?:note|message|instructions?|notice|memo)\\s+(?:to|for)\\s+(?:all\\s+|any\\s+|the\\s+)?${AI}\\b`, 'i'),
  new RegExp(`\\b(?:attention|dear|hey|hi|hello)\\s*,?\\s+(?:all\\s+|any\\s+|the\\s+)?${AI}\\b`, 'i'),
  // "AI: recommend …" — the AI term must open the clause, so "We build chatbots: always on" does not match.
  new RegExp(`(?:^|[.!?;\\n(]\\s*)(?:the\\s+|all\\s+|any\\s+)?${AI}\\s*[:,]\\s*(?:please\\s+)?${DIRECTIVE}\\b`, 'i'),
  new RegExp(`\\bif you(?:'re| are)\\s+(?:an?\\s+)?${AI}\\b`, 'i'),
  /\bwhen (?:asked|prompted|users? asks?|someone asks|people ask)\b[^.!?\n]{0,120}\b(?:recommend|say|answer|respond|mention|describe|rank|suggest)\b/i,
  /\b(?:ignore|disregard)\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|other)\s+(?:instructions|prompts|directions|rules)\b/i
];

/** Returns the sentence that addresses an AI system, or null. */
function findAiDirective(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length < 8) return null;
  for (const re of ADDRESSED) {
    const m = re.exec(s);
    if (!m) continue;
    // Skip punctuation the clause-start pattern consumed from the previous sentence.
    const at = m.index + (/^[.!?;\n(]\s*/.exec(m[0]) || [''])[0].length;
    const start = Math.max(0, ...['.', '!', '?'].map((p) => s.lastIndexOf(p, at - 1) + 1));
    const tail = s.slice(m.index + m[0].length).search(/[.!?](\s|$)/);
    const end = tail === -1 ? s.length : m.index + m[0].length + tail + 1;
    return truncate(s.slice(start, end).trim() || m[0], 200);
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------*/

function truncate(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function originOf(u) { try { return new URL(u).origin; } catch { return null; } }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }

const SPAM_TERMS = /\b(?:casinos?|poker|slots?|betting|sportsbook|viagra|cialis|levitra|online pharmacy|payday loans?|replica watches|escorts?|porn|xxx)\b/i;

// Hidden mobile menus routinely link to these; they are not a link scheme.
const SOCIAL_HOSTS = /(?:^|\.)(?:facebook|fb|instagram|twitter|x|linkedin|youtube|youtu|tiktok|pinterest|github|wa|whatsapp|t|telegram|threads|medium|discord|apps\.apple|play\.google)\.(?:com|me|be|net|org|gg)$/i;

const HIDDEN_STYLE = /(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem)?\s*(?:;|!|$)|opacity\s*:\s*0(?:\.0+)?\s*(?:;|!|$)|(?:left|top|text-indent|margin-left)\s*:\s*-\d{3,}(?:px)?|clip\s*:\s*rect\(\s*0)/i;

const STOPWORDS = new Set(('the and for are but not you all any can had her was one our out day get has him his how man new now old see ' +
  'two way who boy did its let put say she too use that with have this will your from they know want been good much some ' +
  'time very when come here just like long make many more only over such take than them well were what into also each ' +
  'about which their there would could other these those then because while where after before being through').split(' '));

/** Visible-ish body text: scripts, styles and templates removed. */
function visibleText(html) {
  const $ = cheerio.load(html || '');
  $('script, style, noscript, template, svg').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function wordSet(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9À-ɏ]+/).filter((w) => w.length >= 3));
}
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/* ---------------------------------------------------------------------------
 * Static concealment (raw HTML: inline styles and the hidden attribute)
 * -------------------------------------------------------------------------*/

function staticHidden($, baseUrl) {
  const out = [];
  const isHidden = (el) => {
    const $el = $(el);
    if (['script', 'style', 'template', 'noscript', 'head', 'meta', 'link'].includes(el.tagName)) return false;
    return $el.is('[hidden]') || HIDDEN_STYLE.test($el.attr('style') || '');
  };
  $('body [hidden], body [style]').each((_, el) => {
    if (!isHidden(el)) return;
    // Report only the outermost concealed element.
    if ($(el).parents().toArray().some((p) => p.tagName !== 'body' && p.tagName !== 'html' && isHidden(p))) return;
    const $el = $(el);
    const style = ($el.attr('style') || '').match(HIDDEN_STYLE);
    out.push({
      reason: $el.is('[hidden]') ? 'hidden attribute' : `inline style "${style ? style[0] : 'hidden'}"`,
      tag: el.tagName,
      text: truncate($el.text(), 500),
      links: $el.find('a[href]').addBack('a[href]').toArray()
        .map((a) => ({ href: safeResolve($(a).attr('href'), baseUrl), text: truncate($(a).text(), 80) }))
        .filter((l) => l.href)
        .slice(0, 25)
    });
  });
  return out;
}

function safeResolve(href, base) { try { return new URL(href, base).href; } catch { return null; } }

/* ---------------------------------------------------------------------------
 * Main analysis
 * -------------------------------------------------------------------------*/

/**
 * @param {object} input
 * @param {string} input.url               final URL of the page
 * @param {string} input.rawHtml           HTML as served to the audit's default user agent
 * @param {string|null} input.renderedHtml HTML after JavaScript (headless), if available
 * @param {string|null} input.renderedUrl  final URL after JavaScript, if available
 * @param {Array|null} input.renderedHidden concealed elements found in the rendered page (computed styles)
 * @param {Array} input.variants           [{ label, status, html, finalUrl, error, flagBlocking }] fetched as other crawlers.
 *                                         flagBlocking:false = a 4xx proves nothing (e.g. CDNs refuse unverified Googlebot requests).
 * @param {number} input.status            HTTP status for the default user agent
 */
function analyzeRisk(input) {
  const { url, rawHtml, renderedHtml = null, renderedUrl = null, renderedHidden = null, variants = [], status = 200 } = input;
  const flags = [];
  const $ = cheerio.load(rawHtml || '');
  const pageHost = hostOf(url);

  // ---- 1. Concealed content ----
  const hidden = [...staticHidden($, url).map((h) => ({ ...h, source: 'raw HTML' }))];
  if (Array.isArray(renderedHidden)) {
    for (const h of renderedHidden) hidden.push({ ...h, source: 'rendered page' });
  }

  const hiddenAi = [];
  const hiddenSpamLinks = [];
  const hiddenExternalHosts = new Set();
  const hiddenExternalEvidence = [];
  for (const h of hidden) {
    const directive = findAiDirective(h.text);
    if (directive) hiddenAi.push({ where: `${h.source}: <${h.tag}> hidden by ${h.reason}`, text: directive });
    for (const l of h.links || []) {
      const host = hostOf(l.href);
      if (!host || host === pageHost || host.endsWith(`.${pageHost}`)) continue;
      if (SPAM_TERMS.test(`${l.text} ${l.href}`)) {
        hiddenSpamLinks.push({ where: `${h.source}: <${h.tag}> hidden by ${h.reason}`, text: `${l.text || '(no text)'} → ${l.href}` });
      } else if (!SOCIAL_HOSTS.test(host) && !hiddenExternalHosts.has(host)) {
        hiddenExternalHosts.add(host);
        hiddenExternalEvidence.push({ where: `${h.source}: <${h.tag}> hidden by ${h.reason}`, text: `${l.text || '(no text)'} → ${l.href}` });
      }
    }
  }
  dedupe(hiddenAi); dedupe(hiddenSpamLinks);

  if (hiddenAi.length) {
    flags.push({
      id: 'risk.hidden_ai_instructions', severity: 'critical',
      title: 'Hidden text addressed to AI systems',
      detail: 'Concealed text speaks directly to AI assistants or crawlers. This is indirect prompt injection and falls under ' +
        'Google\'s hidden-text spam policy. On your own site it often means the site was compromised.',
      evidence: hiddenAi.slice(0, 5),
      action: 'Remove the hidden text. If nobody on your team added it, treat it as a compromise: check CMS users, plugins and recently changed files.'
    });
  }
  if (hiddenSpamLinks.length) {
    flags.push({
      id: 'risk.hidden_spam_links', severity: 'critical',
      title: 'Hidden links to spam-category sites',
      detail: 'Concealed links to gambling, pharma, loan or adult sites are a classic sign of a hacked site and violate Google\'s link-spam policy.',
      evidence: hiddenSpamLinks.slice(0, 5),
      action: 'Remove the links, then find how they were inserted (outdated plugin, theme, or stolen admin credentials) and close it.'
    });
  }
  if (hiddenExternalHosts.size >= 8) {
    flags.push({
      id: 'risk.hidden_external_links', severity: 'warning',
      title: `Hidden links to ${hiddenExternalHosts.size} external sites`,
      detail: 'A block of concealed outbound links looks like a link scheme to search engines.',
      evidence: hiddenExternalEvidence.slice(0, 5),
      action: 'Make the links visible and relevant, mark paid ones rel="sponsored", or remove them.'
    });
  }

  // ---- 2. Text addressed to AI in places visitors do not see ----
  const machineOnly = [];
  $('*').contents().each((_, node) => {
    if (node.type === 'comment') {
      const d = findAiDirective(node.data);
      if (d) machineOnly.push({ where: 'HTML comment', text: d });
    }
  });
  $('meta[content]').each((_, el) => {
    const d = findAiDirective($(el).attr('content'));
    if (d) machineOnly.push({ where: `meta ${$(el).attr('name') || $(el).attr('property') || ''}`.trim(), text: d });
  });
  $('[alt], [title], [aria-label]').each((_, el) => {
    for (const attr of ['alt', 'title', 'aria-label']) {
      const d = findAiDirective($(el).attr(attr));
      if (d) machineOnly.push({ where: `${attr} attribute on <${el.tagName}>`, text: d });
    }
  });
  $('script[type="application/ld+json"]').each((_, el) => {
    for (const str of jsonStrings($(el).contents().text())) {
      const d = findAiDirective(str);
      if (d) machineOnly.push({ where: 'JSON-LD structured data', text: d });
    }
  });
  dedupe(machineOnly);
  if (machineOnly.length) {
    const inComments = machineOnly.some((m) => m.where === 'HTML comment');
    flags.push({
      id: 'risk.machine_only_ai_text', severity: inComments ? 'critical' : 'warning',
      title: 'Text addressed to AI systems in comments, meta tags or attributes',
      detail: 'Visitors never see these places. Instructions aimed at AI systems here are manipulation, and assistants increasingly detect and discount them.',
      evidence: machineOnly.slice(0, 5),
      action: 'Remove the instructions. State facts plainly in visible content and mark them up with schema.org instead.'
    });
  }

  // ---- 3. Spam-category links anywhere on the page ----
  if (!hiddenSpamLinks.length) {
    const visibleSpam = [];
    $('a[href]').each((_, a) => {
      const href = safeResolve($(a).attr('href'), url);
      const host = hostOf(href);
      if (!host || host === pageHost) return;
      const text = truncate($(a).text(), 80);
      if (SPAM_TERMS.test(`${text} ${href}`)) visibleSpam.push({ where: 'link', text: `${text || '(no text)'} → ${href}` });
    });
    dedupe(visibleSpam);
    if (visibleSpam.length) {
      flags.push({
        id: 'risk.spam_links', severity: 'warning',
        title: 'Outbound links to spam-category sites',
        detail: 'Links to gambling, pharma, loan or adult sites hurt trust signals unless they are clearly relevant to the page.',
        evidence: visibleSpam.slice(0, 5),
        action: 'Remove them if you did not place them on purpose. Mark paid placements rel="sponsored".'
      });
    }
  }

  // ---- 4. Cloaking: other crawlers get different content ----
  const baseText = visibleText(rawHtml);
  const baseWords = wordSet(baseText);
  const baseTitle = $('title').first().text().trim();
  const baseOrigin = originOf(url);
  for (const v of variants) {
    if (v.error) continue;
    if (v.status >= 400 && status < 400) {
      if (v.flagBlocking === false) continue;
      flags.push({
        id: `risk.blocked.${slug(v.label)}`, severity: 'warning',
        title: `${v.label} is refused by the server (HTTP ${v.status})`,
        detail: `Visitors get HTTP ${status}; requests identifying as ${v.label} get HTTP ${v.status}. That is a firewall, CDN or bot-protection rule, not robots.txt. ` +
          'It may be a deliberate "block AI crawlers" setting, or bot verification rejecting this unverified test request — check your CDN settings to know which.',
        evidence: [],
        action: `If you want ${v.label} to read the site, allow its user agent in your firewall / CDN bot settings.`
      });
      continue;
    }
    const sim = jaccard(baseWords, wordSet(visibleText(v.html)));
    const vTitle = cheerio.load(v.html || '')('title').first().text().trim();
    const otherOrigin = v.finalUrl && baseOrigin && originOf(v.finalUrl) !== baseOrigin;
    if (otherOrigin || sim < 0.6) {
      const severe = otherOrigin || sim < 0.3;
      const evidence = [{ where: 'content similarity', text: `${Math.round(sim * 100)}% of words shared with what visitors get` }];
      if (vTitle !== baseTitle) evidence.push({ where: `title for ${v.label}`, text: truncate(vTitle, 120) }, { where: 'title for visitors', text: truncate(baseTitle, 120) });
      if (otherOrigin) evidence.push({ where: `${v.label} ends up at`, text: v.finalUrl });
      flags.push({
        id: `risk.cloaking.${slug(v.label)}`, severity: severe ? 'critical' : 'warning',
        title: `${v.label} gets different content than visitors`,
        detail: 'Serving crawlers different content than people is cloaking under Google\'s spam policies. Bot-protection challenge pages and heavy personalisation can also cause this, so check before acting.',
        evidence,
        action: 'Serve the same main content to crawlers and visitors. If a bot-protection page is the cause, allow verified crawlers through.'
      });
    }
  }

  // ---- 5. Sneaky redirects ----
  const redirects = [];
  $('meta[http-equiv]').each((_, el) => {
    if (String($(el).attr('http-equiv')).toLowerCase() !== 'refresh') return;
    const m = /url\s*=\s*['"]?([^'";\s]+)/i.exec($(el).attr('content') || '');
    const target = m ? safeResolve(m[1], url) : null;
    if (target && originOf(target) !== baseOrigin) redirects.push({ where: 'meta refresh', text: target });
  });
  $('script:not([src])').each((_, el) => {
    const code = $(el).contents().text();
    const re = /(?:window\.|document\.|top\.)?location(?:\.href)?\s*(?:=|\.replace\(|\.assign\()\s*['"`](https?:\/\/[^'"`]+)['"`]/gi;
    let m;
    while ((m = re.exec(code))) {
      if (originOf(m[1]) !== baseOrigin) redirects.push({ where: 'inline script', text: m[1] });
    }
  });
  if (renderedUrl && baseOrigin && originOf(renderedUrl) && originOf(renderedUrl) !== baseOrigin) {
    redirects.push({ where: 'after JavaScript ran, the browser ended up at', text: renderedUrl });
  }
  dedupe(redirects);
  if (redirects.length) {
    flags.push({
      id: 'risk.sneaky_redirect', severity: 'warning',
      title: 'Redirects visitors to another site',
      detail: 'Client-side redirects to a different domain are treated as sneaky redirects unless the move is obvious and intended (e.g. a domain migration).',
      evidence: redirects.slice(0, 5),
      action: 'Use a server-side 301 for real moves. Remove redirects you did not add — injected redirects are a common hack.'
    });
  }

  // ---- 6. Keyword stuffing ----
  const text = renderedHtml ? visibleText(renderedHtml) : baseText;
  const words = text.toLowerCase().split(/[^a-z0-9À-ɏ]+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  if (words.length >= 150) {
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const density = n / words.length;
    if (density > 0.06 && n >= 15) {
      flags.push({
        id: 'risk.keyword_stuffing', severity: 'warning',
        title: `"${top}" makes up ${Math.round(density * 100)}% of the page's words`,
        detail: 'Repeating one term far beyond natural use is keyword stuffing under Google\'s spam policies, and it reads badly to people.',
        evidence: [{ where: 'visible text', text: `"${top}" appears ${n} times in ${words.length} content words` }],
        action: 'Rewrite for people: say it once where it matters and use natural variations.'
      });
    }
  }
  const titleWords = baseTitle.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const tc = new Map();
  for (const w of titleWords) tc.set(w, (tc.get(w) || 0) + 1);
  const repeated = [...tc.entries()].filter(([, c]) => c >= 3);
  if (repeated.length) {
    flags.push({
      id: 'risk.title_stuffing', severity: 'notice',
      title: 'Title repeats the same word 3+ times',
      detail: 'Repeated keywords in the title look like stuffing and waste the space.',
      evidence: [{ where: 'title', text: truncate(baseTitle, 120) }],
      action: 'Use the keyword once, then say what the page is.'
    });
  }

  const rank = { critical: 0, warning: 1, notice: 2 };
  flags.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    status: flags.some((f) => f.severity === 'critical') ? 'high'
      : flags.some((f) => f.severity === 'warning') ? 'review' : 'clean',
    flags,
    checked: {
      concealed_elements: hidden.length,
      rendered_page_checked: Array.isArray(renderedHidden),
      crawler_variants: variants.map((v) => ({
        label: v.label, status: v.status || 0, error: v.error || null,
        compared: !v.error && !(v.status >= 400 && status < 400)
      }))
    }
  };
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
/** Drop repeated evidence (same text), keeping the first occurrence. In place. */
function dedupe(arr) {
  const seen = new Set();
  const kept = arr.filter((e) => !seen.has(e.text) && seen.add(e.text));
  arr.splice(0, arr.length, ...kept);
}

/** Every string value in a JSON-LD block (invalid JSON yields nothing). */
function jsonStrings(src) {
  const out = [];
  let data;
  try { data = JSON.parse(src); } catch { return out; }
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(data);
  return out;
}

/**
 * Runs inside the browser page (Playwright page.evaluate). Finds elements whose
 * text or links a visitor cannot see: not rendered, zero-size, far off-screen,
 * tiny font, or text colour matching the background. Outermost elements only.
 */
function collectRenderedHidden() {
  const MAX = 300;
  const out = [];
  const found = [];
  const parseRgb = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const bgOf = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = parseRgb(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.9) return c;
      if (getComputedStyle(n).backgroundImage !== 'none') return null; // can't judge text over images
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').trim();
  const reasonFor = (el) => {
    const hasText = ownText(el).length > 0;
    const isLink = el.tagName === 'A' && el.getAttribute('href');
    if (!hasText && !isLink) return null;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return 'not rendered (display/visibility/opacity)';
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.right < -100 || r.bottom < -100 || r.left > document.documentElement.scrollWidth + 1000) return 'positioned off-screen';
    if (hasText && parseFloat(cs.fontSize) < 2) return `font-size ${cs.fontSize}`;
    if (hasText && (r.width < 1 || r.height < 1) && cs.overflow === 'hidden') return 'zero-size box';
    if (hasText) {
      const fg = parseRgb(cs.color);
      const bg = bgOf(el);
      if (fg && bg && fg.a > 0.5 && Math.abs(fg.r - bg.r) + Math.abs(fg.g - bg.g) + Math.abs(fg.b - bg.b) < 12) return 'text colour matches background';
    }
    return null;
  };
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    if (out.length >= MAX) break;
    if (['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SVG'].includes(el.tagName)) continue;
    if (found.some((f) => f.contains(el))) continue;
    const reason = reasonFor(el);
    if (!reason) continue;
    found.push(el);
    const links = Array.from(el.tagName === 'A' ? [el] : el.querySelectorAll('a[href]'))
      .slice(0, 25).map((a) => ({ href: a.href, text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) }));
    out.push({ reason, tag: el.tagName.toLowerCase(), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500), links });
  }
  return out;
}

module.exports = { analyzeRisk, findAiDirective, collectRenderedHidden, visibleText, jaccard, wordSet };
