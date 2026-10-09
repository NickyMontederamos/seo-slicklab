'use strict';

/**
 * Advisor — turns one audit into the answer a site owner needs: what to fix first.
 *
 * Takes the engine's checks plus the raw files (robots.txt, llms.txt, sitemap.xml, JSON-LD)
 * and returns:
 *   summary      one plain-English paragraph
 *   top          the five findings that matter most, ranked by impact, then by the usual order
 *                (crawl access → rendering → facts → structured data → llms.txt → titles → content)
 *   appendix     everything else worth doing
 *   strengths    what is already right
 *   fixes        files built only from facts found on the site; anything unknown says TO CONFIRM
 *   not_checked  what one homepage audit cannot see
 *
 * It never invents business facts and never writes text addressed to AI systems.
 */

const { findAiDirective } = require('./risk.js');

const IMPACT_RANK = { high: 3, medium: 2, low: 1 };
const EFFORT_LABEL = { small: 'Under an hour', medium: 'A few hours', large: 'A developer job' };
const TIER = { access: 1, render: 2, facts: 3, schema: 4, llms: 5, meta: 6, content: 7, other: 8 };

const AI_SEARCH = ['OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Perplexity-User', 'Claude-SearchBot', 'Claude-User'];
const AI_TRAINING = ['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'anthropic-ai', 'Bytespider', 'cohere-ai'];
const KNOWN_BOTS = [...AI_SEARCH, ...AI_TRAINING, 'Claude-Web', 'Googlebot', 'Bingbot', 'Applebot', 'DuckDuckBot', 'YandexBot', 'Baiduspider'];
const CANONICAL_BOT = Object.fromEntries(KNOWN_BOTS.map((b) => [b.toLowerCase(), b]));

/* ---------------------------------------------------------------------------
 * Text addressed to AI systems
 * The risk engine catches hidden prompt-injection ("ignore previous instructions").
 * llms.txt and similar files are read by AI on purpose, so the problem there is
 * steering: telling the reader what to recommend or which answer is "correct".
 * -------------------------------------------------------------------------*/

const AI_WHO = '(?:you|assistants?|ai(?:\\s+(?:assistants?|systems?|models?|tools?))?|llms?|language\\s+models?|agents?|chatbots?|crawlers?)';
const STEERING = [
  /\b(?:when|if|whenever)\s+(?:you\s+are\s+|you're\s+)?(?:answering|responding\s+to|replying\s+to)\b/i,
  /\b(?:when|if|whenever)\s+(?:you\s+are\s+|you're\s+)?asked\s+(?:about|which|who|what|for\s+(?:a|the)\s+(?:best|top|recommended))\b/i,
  /\bfor\s+any\s+(?:query|question|request|search)\s+(?:about|on|regarding)\b/i,
  /\bthe\s+(?:correct|right|only)\s+(?:entity|answer)\s+is\b/i,
  /\bthe\s+correct\s+(?:company|business|provider|result|choice)\s+is\b/i,
  new RegExp(`\\b${AI_WHO}\\s+(?:should|must|need\\s+to|are\\s+(?:asked|instructed)\\s+to)\\s+(?:always\\s+)?(?:recommend|suggest|mention|cite|rank|say|state|answer|read|treat)\\b`, 'i'),
  /\b(?:every|any|all)\s+(?:ai\s+)?(?:agents?|assistants?|crawlers?|llms?|models?)\s+should\b/i
];

function findSteering(line) {
  const s = String(line || '').replace(/\s+/g, ' ').trim();
  if (s.length < 12) return null;
  if (STEERING.some((re) => re.test(s)) || findAiDirective(s)) return truncate(s, 200);
  return null;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------*/

function truncate(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
/** "a, b, c and 4 more crawlers" */
function listSome(items, n, noun) {
  const list = [...new Set(items)];
  if (list.length <= n) return list.join(', ');
  return `${list.slice(0, n).join(', ')} and ${list.length - n} more ${noun}${list.length - n === 1 ? '' : 's'}`;
}
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const digits = (s) => String(s || '').replace(/\D/g, '');
/** Compare phone numbers by their last 9 digits so +63 945… and 0945… match. */
const phoneKey = (s) => { const d = digits(s); return d.length >= 7 ? d.slice(-9) : null; };

function originOf(u) { try { return new URL(u).origin; } catch { return ''; } }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

function failedChecks(modules) {
  const out = new Map();
  for (const m of Object.values(modules || {})) {
    for (const c of m.checks || []) if (c.status === 'fail') out.set(c.id, c);
  }
  return out;
}

/** Walk every JSON-LD node (top level, @graph, nested values). */
function walkNodes(blocks, fn) {
  const seen = new Set();
  const visit = (n) => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (n['@type']) fn(n);
    for (const v of Object.values(n)) if (v && typeof v === 'object') visit(v);
  };
  asArray(blocks).forEach(visit);
}

/* ---------------------------------------------------------------------------
 * schema.org vocabulary checks
 * A curated list of the types business sites use. Anything else is reported as
 * "not one we recognise — check it", never as a hard error.
 * -------------------------------------------------------------------------*/

const ORG_TYPES = new Set([
  'Organization', 'Corporation', 'LocalBusiness', 'ProfessionalService', 'OnlineBusiness', 'OnlineStore',
  'NGO', 'EducationalOrganization', 'GovernmentOrganization', 'MedicalOrganization', 'NewsMediaOrganization',
  'SportsOrganization', 'PerformingGroup', 'Airline', 'Consortium', 'FundingScheme', 'LibrarySystem',
  'ResearchOrganization', 'WorkersUnion', 'Project', 'Store', 'AutomotiveBusiness', 'ChildCare', 'Dentist',
  'DryCleaningOrLaundry', 'EmergencyService', 'EmploymentAgency', 'EntertainmentBusiness', 'FinancialService',
  'FoodEstablishment', 'Restaurant', 'CafeOrCoffeeShop', 'Bakery', 'BarOrPub', 'FastFoodRestaurant',
  'GovernmentOffice', 'HealthAndBeautyBusiness', 'HomeAndConstructionBusiness', 'Electrician', 'GeneralContractor',
  'HVACBusiness', 'HousePainter', 'Locksmith', 'MovingCompany', 'Plumber', 'RoofingContractor',
  'InternetCafe', 'LegalService', 'Attorney', 'Notary', 'Library', 'LodgingBusiness', 'Hotel', 'Resort',
  'MedicalBusiness', 'Physician', 'Pharmacy', 'Optician', 'MedicalClinic', 'RadioStation', 'RealEstateAgent',
  'RecyclingCenter', 'SelfStorage', 'ShoppingCenter', 'SportsActivityLocation', 'TelevisionStation',
  'TouristInformationCenter', 'TravelAgency', 'AccountingService', 'AutoRepair', 'AutoDealer', 'BeautySalon',
  'DaySpa', 'HairSalon', 'NailSalon', 'HealthClub', 'ExerciseGym', 'BankOrCreditUnion', 'InsuranceAgency',
  'ClothingStore', 'ComputerStore', 'ElectronicsStore', 'Florist', 'FurnitureStore', 'GroceryStore',
  'HardwareStore', 'JewelryStore', 'PetStore', 'ShoeStore', 'BookStore', 'BikeStore', 'ToyStore',
  'CollegeOrUniversity', 'School', 'Preschool', 'HighSchool', 'ElementarySchool', 'Hospital', 'VeterinaryCare',
  'AnimalShelter', 'ArchiveOrganization', 'Campground', 'TaxiService', 'PostOffice'
]);
const OTHER_TYPES = new Set([
  'Thing', 'Person', 'Place', 'Event', 'Product', 'Service', 'Offer', 'AggregateOffer', 'OfferCatalog',
  'PriceSpecification', 'UnitPriceSpecification', 'CompoundPriceSpecification', 'WebSite', 'WebPage',
  'AboutPage', 'ContactPage', 'CollectionPage', 'FAQPage', 'QAPage', 'ProfilePage', 'ItemPage', 'SearchResultsPage',
  'CheckoutPage', 'MedicalWebPage', 'RealEstateListing', 'WebPageElement', 'SiteNavigationElement', 'WPHeader',
  'WPFooter', 'Article', 'NewsArticle', 'BlogPosting', 'Blog', 'TechArticle', 'Report', 'ScholarlyArticle',
  'CreativeWork', 'HowTo', 'HowToStep', 'HowToSection', 'Recipe', 'Review', 'AggregateRating', 'Rating',
  'Question', 'Answer', 'ItemList', 'ListItem', 'BreadcrumbList', 'ImageObject', 'VideoObject', 'AudioObject',
  'MediaObject', 'PostalAddress', 'GeoCoordinates', 'GeoShape', 'GeoCircle', 'Country', 'State', 'City',
  'AdministrativeArea', 'ContactPoint', 'OpeningHoursSpecification', 'Brand', 'SearchAction', 'EntryPoint',
  'ReadAction', 'BuyAction', 'Course', 'CourseInstance', 'JobPosting', 'SoftwareApplication', 'WebApplication',
  'MobileApplication', 'VideoGame', 'Book', 'Movie', 'MusicRecording', 'Dataset', 'DataDownload',
  'EducationalOccupationalCredential', 'Occupation', 'MonetaryAmount', 'QuantitativeValue', 'PropertyValue',
  'DefinedTerm', 'DefinedTermSet', 'Language', 'SpeakableSpecification', 'ClaimReview', 'Claim', 'Comment',
  'Duration', 'Audience', 'BusinessAudience', 'PeopleAudience', 'MerchantReturnPolicy', 'OfferShippingDetails',
  'ShippingDeliveryTime', 'DeliveryTimeSettings', 'Trip', 'Menu', 'MenuItem', 'MenuSection', 'Reservation',
  'Schedule', 'VirtualLocation', 'LocationFeatureSpecification', 'NutritionInformation', 'Distance',
  'SoftwareSourceCode', 'Code', 'Collection', 'Map', 'Photograph', 'PodcastSeries', 'PodcastEpisode',
  'Episode', 'Clip', 'Game', 'LearningResource', 'Quiz', 'Guide', 'ItemListOrderType', 'DayOfWeek'
]);
const KNOWN_TYPES = new Set([...ORG_TYPES, ...OTHER_TYPES]);

// Properties that look right but are not schema.org, with what to use instead.
const BAD_PROPS = {
  businessHoursSpecification: 'openingHoursSpecification on the business, or hoursAvailable on a ContactPoint',
  businessHours: 'openingHoursSpecification',
  openingHoursSpecifications: 'openingHoursSpecification',
  phone: 'telephone',
  phoneNumber: 'telephone',
  website: 'url',
  socialProfiles: 'sameAs',
  services: 'hasOfferCatalog or makesOffer'
};
const RENAME_PROP = {
  businessHours: 'openingHoursSpecification', openingHoursSpecifications: 'openingHoursSpecification',
  phone: 'telephone', phoneNumber: 'telephone', website: 'url', socialProfiles: 'sameAs'
};

/** Short country list for matching areaServed codes against names in llms.txt. */
const COUNTRIES = {
  PH: 'Philippines', AU: 'Australia', US: 'United States', GB: 'United Kingdom', UK: 'United Kingdom',
  CA: 'Canada', NZ: 'New Zealand', SG: 'Singapore', MY: 'Malaysia', ID: 'Indonesia', TH: 'Thailand',
  VN: 'Vietnam', JP: 'Japan', KR: 'South Korea', CN: 'China', HK: 'Hong Kong', TW: 'Taiwan', IN: 'India',
  AE: 'United Arab Emirates', SA: 'Saudi Arabia', QA: 'Qatar', IL: 'Israel', DE: 'Germany', FR: 'France',
  ES: 'Spain', IT: 'Italy', NL: 'Netherlands', IE: 'Ireland', SE: 'Sweden', NO: 'Norway', DK: 'Denmark',
  FI: 'Finland', CH: 'Switzerland', AT: 'Austria', BE: 'Belgium', PL: 'Poland', PT: 'Portugal',
  RU: 'Russia', UA: 'Ukraine', TR: 'Turkey', BR: 'Brazil', MX: 'Mexico', AR: 'Argentina', CL: 'Chile',
  CO: 'Colombia', ZA: 'South Africa', NG: 'Nigeria', KE: 'Kenya', EG: 'Egypt'
};
const COUNTRY_BY_NAME = Object.fromEntries(Object.entries(COUNTRIES).map(([c, n]) => [n.toLowerCase(), c === 'UK' ? 'GB' : c]));
COUNTRY_BY_NAME.usa = 'US'; COUNTRY_BY_NAME['united states of america'] = 'US'; COUNTRY_BY_NAME.uk = 'GB';

function countryCode(v) {
  const s = String((v && typeof v === 'object') ? (v.name || v['@id'] || '') : v || '').trim();
  if (!s) return null;
  if (/^[A-Z]{2}$/.test(s)) return s === 'UK' ? 'GB' : (COUNTRIES[s] ? s : null);
  return COUNTRY_BY_NAME[s.toLowerCase()] || null;
}

function countriesNamedIn(text) {
  const found = new Set();
  const lower = String(text || '').toLowerCase();
  for (const [name, code] of Object.entries(COUNTRY_BY_NAME)) {
    if (name.length < 4) continue; // "usa"/"uk" are too ambiguous in prose
    if (new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`).test(lower)) found.add(code);
  }
  return found;
}

/* ---------------------------------------------------------------------------
 * Facts found on the page
 * -------------------------------------------------------------------------*/

function extractFacts(input) {
  const { doc, rawHtml, url } = input;
  const facts = {
    name: null, description: null, phones: [], emails: [], address: null, hours: [],
    sameAs: [], areaServed: [], orgNodes: [], pages: []
  };

  walkNodes(doc.jsonLd || [], (n) => {
    const types = asArray(n['@type']);
    if (types.some((t) => ORG_TYPES.has(t)) || (types.some((t) => !KNOWN_TYPES.has(t)) && (n.address || n.telephone))) {
      facts.orgNodes.push(n);
    }
  });
  const org = facts.orgNodes[0] || null;

  if (org) {
    facts.name = typeof org.name === 'string' ? org.name : null;
    facts.description = typeof org.description === 'string' ? org.description : null;
    const addr = asArray(org.address)[0];
    if (addr && typeof addr === 'object') {
      facts.address = [addr.streetAddress, addr.addressLocality, addr.postalCode, addr.addressCountry]
        .filter((x) => typeof x === 'string' && x.trim()).join(', ') || null;
    } else if (typeof addr === 'string') facts.address = addr;
    for (const spec of asArray(org.openingHoursSpecification)) {
      if (spec && spec.opens && spec.closes) {
        const days = asArray(spec.dayOfWeek).map((d) => String(d).replace(/^https?:\/\/schema\.org\//, ''));
        facts.hours.push(`${days.join(', ')}: ${spec.opens}–${spec.closes}`);
      }
    }
    for (const h of asArray(org.openingHours)) if (typeof h === 'string') facts.hours.push(h);
  }
  for (const n of facts.orgNodes) {
    for (const t of asArray(n.telephone)) if (typeof t === 'string') facts.phones.push({ value: t, source: 'schema' });
    for (const cp of asArray(n.contactPoint)) {
      for (const t of asArray(cp && cp.telephone)) if (typeof t === 'string') facts.phones.push({ value: t, source: 'schema' });
    }
    for (const e of asArray(n.email)) if (typeof e === 'string') facts.emails.push(e.replace(/^mailto:/i, ''));
    for (const s of asArray(n.sameAs)) if (typeof s === 'string' && /^https?:\/\//.test(s)) facts.sameAs.push(s);
    for (const a of asArray(n.areaServed)) facts.areaServed.push(a);
  }

  const html = String(rawHtml || '');
  for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) facts.phones.push({ value: decodeURIComponentSafe(m[1]), source: 'link' });
  for (const m of html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)) facts.emails.push(decodeURIComponentSafe(m[1]));

  if (!facts.name) {
    const og = doc.og && (doc.og['og:site_name'] || doc.og.site_name);
    facts.name = og || nameFromTitle(doc.title) || hostOf(url) || null;
  }
  if (!facts.description) facts.description = doc.metaDescription || null;
  if (facts.description && findSteering(facts.description)) facts.description = null;

  facts.emails = [...new Set(facts.emails.map((e) => e.trim().toLowerCase()).filter((e) => /@/.test(e)))];
  facts.sameAs = [...new Set(facts.sameAs)];

  // Key pages: internal links in page order, one per path, with a readable label.
  const seen = new Set([pathOf(url)]);
  for (const l of doc.links || []) {
    if (!l.internal || l.isAnchor || !l.resolved) continue;
    const p = pathOf(l.resolved);
    const label = String(l.text || l.ariaLabel || '').replace(/[→›»↗]+/g, '').trim();
    if (seen.has(p) || label.length < 2 || label.length > 40) continue;
    if (/^(skip|menu|close|open|toggle|home)\b/i.test(label) || /\.(jpe?g|png|pdf|zip)$/i.test(p)) continue;
    seen.add(p);
    facts.pages.push({ label, url: l.resolved.split('#')[0] });
    if (facts.pages.length >= 10) break;
  }
  return facts;
}

function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }
function pathOf(u) { try { const x = new URL(u); return x.pathname.replace(/\/+$/, '') || '/'; } catch { return u; } }
function nameFromTitle(t) {
  const parts = String(t || '').split(/\s[|–—-]\s|\s·\s/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

/* ---------------------------------------------------------------------------
 * robots.txt
 * -------------------------------------------------------------------------*/

function groupsFor(parsed, bot) {
  const b = bot.toLowerCase();
  const exact = parsed.groups.filter((g) => g.agents.includes(b));
  return exact.length ? exact : parsed.groups.filter((g) => g.agents.includes('*'));
}
function blocksRoot(groups) {
  const rules = groups.flatMap((g) => g.rules);
  return rules.some((r) => r.type === 'disallow' && (r.path === '/' || r.path === '/*')) &&
    !rules.some((r) => r.type === 'allow' && (r.path === '/' || r.path === '/*'));
}

function analyzeRobots(robots, parsed) {
  const out = { missing: false, blocksAll: false, blockedSearch: [], blockedTraining: [], gaps: [], starDisallows: [] };
  if (!robots || robots.status === 404 || robots.status === 410) { out.missing = true; return out; }
  if (!parsed) return out;
  const star = parsed.groups.filter((g) => g.agents.includes('*'));
  out.blocksAll = star.length > 0 && blocksRoot(star);
  out.starDisallows = star.flatMap((g) => g.rules)
    .filter((r) => r.type === 'disallow' && r.path && r.path !== '/' && r.path !== '/*').map((r) => r.path);
  out.blockedSearch = AI_SEARCH.filter((b) => blocksRoot(groupsFor(parsed, b)));
  out.blockedTraining = AI_TRAINING.filter((b) => blocksRoot(groupsFor(parsed, b)));
  // A crawler that matches a named group ignores the * group entirely.
  if (out.starDisallows.length) {
    for (const g of parsed.groups) {
      if (g.agents.includes('*')) continue;
      const own = new Set(g.rules.filter((r) => r.type === 'disallow').map((r) => r.path));
      const missing = out.starDisallows.filter((p) => !own.has(p));
      if (missing.length && !blocksRoot([g])) out.gaps.push({ agents: g.agents, missing });
    }
  }
  return out;
}

function buildRobotsFile(parsed, info, sitemapUrl) {
  const groups = parsed ? parsed.groups.map((g) => ({ agents: [...g.agents], rules: g.rules.map((r) => ({ ...r })) })) : [];
  let star = groups.find((g) => g.agents.includes('*'));
  if (!star) { star = { agents: ['*'], rules: [{ type: 'allow', path: '/' }] }; groups.unshift(star); }
  if (info.blocksAll) {
    star.rules = star.rules.filter((r) => !(r.type === 'disallow' && (r.path === '/' || r.path === '/*')));
    if (!star.rules.some((r) => r.type === 'allow' && r.path === '/')) star.rules.unshift({ type: 'allow', path: '/' });
  }
  const starDisallows = star.rules.filter((r) => r.type === 'disallow');
  const searchLower = new Set(AI_SEARCH.map((b) => b.toLowerCase()));
  // Unblock AI search crawlers only; training crawlers keep whatever the owner chose.
  for (const g of [...groups]) {
    if (g === star || !blocksRoot([g])) continue;
    const search = g.agents.filter((a) => searchLower.has(a));
    if (!search.length) continue;
    g.agents = g.agents.filter((a) => !searchLower.has(a));
    const freed = { agents: search, rules: [{ type: 'allow', path: '/' }] };
    if (g.agents.length) groups.splice(groups.indexOf(g) + 1, 0, freed);
    else Object.assign(g, freed);
  }
  // A named group ignores the * group, so it needs the * Disallow lines repeated.
  for (const g of groups) {
    if (g === star || blocksRoot([g])) continue;
    const own = new Set(g.rules.filter((r) => r.type === 'disallow').map((r) => r.path));
    for (const r of starDisallows) if (!own.has(r.path)) g.rules.push({ type: 'disallow', path: r.path });
  }
  // Named groups that ended up with identical rules print as one group.
  const merged = [];
  for (const g of groups) {
    const key = JSON.stringify(g.rules);
    const same = g !== star && merged.find((m) => m !== star && JSON.stringify(m.rules) === key);
    if (same) same.agents.push(...g.agents.filter((a) => !same.agents.includes(a)));
    else merged.push(g);
  }
  groups.length = 0; groups.push(...merged);
  const sitemaps = parsed && parsed.sitemaps.length ? parsed.sitemaps : (sitemapUrl ? [sitemapUrl] : []);
  const L = ['# Reviewed by seo.slicklab.digital. Check it before uploading:',
    '# comments from your original file are not carried over.', ''];
  for (const g of groups) {
    for (const a of g.agents) L.push(`User-agent: ${CANONICAL_BOT[a] || a}`);
    for (const r of g.rules) L.push(`${r.type === 'allow' ? 'Allow' : 'Disallow'}: ${r.path}`);
    L.push('');
  }
  for (const s of sitemaps) L.push(`Sitemap: ${s}`);
  return L.join('\n').trimEnd() + '\n';
}

/* ---------------------------------------------------------------------------
 * llms.txt
 * -------------------------------------------------------------------------*/

function buildLlmsDraft(facts, origin) {
  const L = [`# ${facts.name || 'TO CONFIRM: business name'}`, ''];
  L.push(`> ${facts.description ? truncate(facts.description, 300) : 'TO CONFIRM: one or two sentences on what you do, for whom, and where.'}`, '');
  L.push('## Contact');
  const phone = facts.phones[0] && facts.phones[0].value;
  L.push(`- Phone: ${phone || 'TO CONFIRM'}`);
  L.push(`- Email: ${facts.emails[0] || 'TO CONFIRM'}`);
  L.push(`- Address: ${facts.address || 'TO CONFIRM (or say "online only")'}`);
  L.push(`- Hours: ${facts.hours.length ? facts.hours.join('; ') : 'TO CONFIRM'}`);
  L.push('- Service area: TO CONFIRM (name the towns or countries)', '');
  L.push('## Key pages');
  L.push(`- [Home](${origin}/)`);
  for (const p of facts.pages) L.push(`- [${p.label.replace(/[[\]]/g, '')}](${p.url})`);
  if (facts.sameAs.length) {
    L.push('', '## Profiles');
    for (const s of facts.sameAs.slice(0, 8)) L.push(`- [${hostOf(s) || s}](${s})`);
  }
  return L.join('\n') + '\n';
}

/** Repair an existing llms.txt: drop lines that steer AI, add a summary line, turn "- Label: URL" into links. */
function repairLlms(text, facts) {
  const removed = [];
  let lines = String(text).split(/\r?\n/).filter((line) => {
    const hit = findSteering(line);
    if (hit) removed.push(hit);
    return !hit;
  });
  lines = lines.map((line) => {
    const m = /^(\s*[-*]\s+)([^:[\]]{2,80}?):\s+(https?:\/\/\S+?)\s*$/.exec(line);
    return m ? `${m[1]}[${m[2].trim()}](${m[3]})` : line;
  });
  if (!lines.some((l) => /^>\s+\S/.test(l))) {
    const h1 = lines.findIndex((l) => /^#\s+\S/.test(l));
    const summary = `> ${facts.description ? truncate(facts.description, 300) : 'TO CONFIRM: one or two sentences on what you do, for whom, and where.'}`;
    if (h1 >= 0) lines.splice(h1 + 1, 0, '', summary);
    else lines.unshift(`# ${facts.name || 'TO CONFIRM: business name'}`, '', summary, '');
  }
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', removed };
}

/* ---------------------------------------------------------------------------
 * JSON-LD repairs
 * -------------------------------------------------------------------------*/

function schemaProblems(blocks) {
  const unknownTypes = new Set();
  const badProps = new Map();
  walkNodes(blocks, (n) => {
    for (const t of asArray(n['@type'])) {
      const name = String(t).replace(/^https?:\/\/schema\.org\//, '');
      if (!KNOWN_TYPES.has(name)) unknownTypes.add(name);
    }
    for (const k of Object.keys(n)) if (BAD_PROPS[k]) badProps.set(k, BAD_PROPS[k]);
  });
  return { unknownTypes: [...unknownTypes], badProps: [...badProps] };
}

function repairSchemaBlock(block) {
  const copy = JSON.parse(JSON.stringify(block));
  walkNodes(copy, (n) => {
    const types = asArray(n['@type']).map((t) => String(t));
    const kept = types.filter((t) => KNOWN_TYPES.has(t.replace(/^https?:\/\/schema\.org\//, '')));
    if (kept.length !== types.length) n['@type'] = kept.length > 1 ? kept : (kept[0] || 'Organization');
    for (const [k, v] of Object.entries(n)) {
      if (k === 'businessHoursSpecification') {
        delete n[k];
        const isContact = asArray(n['@type']).includes('ContactPoint');
        const specs = asArray(v).map((s) => (s && typeof s === 'object' && !s['@type'] ? { '@type': 'OpeningHoursSpecification', ...s } : s));
        n[isContact ? 'hoursAvailable' : 'openingHoursSpecification'] = specs.length === 1 ? specs[0] : specs;
      } else if (RENAME_PROP[k] && n[RENAME_PROP[k]] === undefined) {
        delete n[k];
        n[RENAME_PROP[k]] = v;
      }
    }
  });
  return copy;
}

function buildOrgSchema(facts, origin) {
  const node = { '@context': 'https://schema.org', '@type': 'Organization', '@id': `${origin}/#organization`, name: facts.name || undefined, url: `${origin}/` };
  if (facts.description) node.description = truncate(facts.description, 300);
  if (facts.phones[0]) node.telephone = facts.phones[0].value;
  if (facts.emails[0]) node.email = facts.emails[0];
  if (facts.sameAs.length) node.sameAs = facts.sameAs.slice(0, 10);
  return JSON.parse(JSON.stringify(node));
}

const scriptTag = (obj) => `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n</script>\n`;

/* ---------------------------------------------------------------------------
 * Findings
 * -------------------------------------------------------------------------*/

function finding(id, tier, impact, effort, title, why, fix, extra = {}) {
  return { id, tier: TIER[tier], area: tier, impact, effort, effort_label: EFFORT_LABEL[effort], title, why, fix, ...extra };
}

function buildAdvice(input) {
  const {
    url, httpStatus = 200, modules = {}, risk = null, doc, rawDoc, renderedDoc = null,
    robots = null, robotsParsed = null, llms = null, llmsIsText = false, sitemap = null,
    headlessAvailable = false
  } = input;
  const origin = originOf(url);
  const failed = failedChecks(modules);
  const facts = extractFacts(input);
  const findings = [];
  const fixes = [];
  const strengths = [];
  const addFix = (f) => { if (!fixes.some((x) => x.id === f.id)) fixes.push(f); return f.id; };

  /* ---- 1. Crawl access ---- */
  if (httpStatus >= 400 || httpStatus === 0) {
    findings.push(finding('http.error', 'access', 'high', 'small',
      `The homepage returns an error (HTTP ${httpStatus || 'no response'})`,
      'Search engines and AI crawlers drop pages that return errors.',
      'Check the server and hosting first. Nothing else on this list matters until the page loads.'));
  }
  if (failed.has('robots.noindex') || failed.has('server.x_robots_tag')) {
    findings.push(finding('page.noindex', 'access', 'high', 'small',
      'The homepage tells search engines not to index it',
      'A "noindex" in the page or in the X-Robots-Tag header keeps it out of Google and out of AI answers that rely on search.',
      'Remove "noindex" from the robots meta tag and the X-Robots-Tag header, unless this site is meant to stay hidden.'));
  }
  if (failed.has('geo.bot_wall')) {
    findings.push(finding('geo.bot_wall', 'access', 'high', 'medium',
      'A bot wall answers crawlers instead of your page',
      failed.get('geo.bot_wall').message || 'The first response is a challenge page, not your content.',
      'In your CDN or security plugin, allow verified search and AI crawlers, or lower the challenge level for the homepage.'));
  }

  const rb = analyzeRobots(robots, robotsParsed);
  const robotsFixNeeded = rb.blocksAll || rb.blockedSearch.length > 0 || rb.gaps.length > 0 ||
    (!rb.missing && robotsParsed && !robotsParsed.sitemaps.length && sitemap && sitemap.ok);
  let robotsFixId = null;
  if (robotsFixNeeded) {
    robotsFixId = addFix({ id: 'robots', file: 'robots.txt', title: 'robots.txt',
      note: 'Replace /robots.txt. Check it before uploading.',
      content: buildRobotsFile(robotsParsed, rb, sitemap && sitemap.ok ? sitemap.url : null) });
  }
  if (rb.blocksAll) {
    findings.push(finding('robots.blocks_all', 'access', 'high', 'small',
      'robots.txt blocks every crawler from the whole site',
      '"Disallow: /" for all user agents keeps search engines and AI crawlers out completely. Staging sites do this on purpose; a live site rarely should.',
      'If this site is live, remove "Disallow: /" from the "User-agent: *" group.', { fix_file: robotsFixId }));
  } else if (rb.blockedSearch.length) {
    findings.push(finding('robots.blocks_ai_search', 'access', 'high', 'small',
      `robots.txt blocks AI search crawlers (${rb.blockedSearch.join(', ')})`,
      'These are the crawlers that fetch pages so ChatGPT, Claude and Perplexity can quote and link you in answers. Blocking them means assistants can\'t read your site. Some owners do this on purpose; it\'s your call.',
      'If you want to be quoted in AI answers, allow these crawlers. The file below allows only the search crawlers and leaves any training-crawler blocks as they are.',
      { fix_file: robotsFixId }));
  }
  if (rb.gaps.length) {
    const who = rb.gaps.flatMap((g) => g.agents).map((a) => CANONICAL_BOT[a] || a);
    findings.push(finding('robots.named_group_gap', 'access', 'medium', 'small',
      'Crawlers you named in robots.txt skip your Disallow rules',
      `A crawler that matches its own group ignores the "User-agent: *" group. So ${listSome(who, 3, 'crawler')} may crawl ${listSome(rb.gaps[0].missing, 3, 'path')}, which you meant to keep private.`,
      'Repeat the Disallow lines in every named group. The file below does that.', { fix_file: robotsFixId }));
  }
  if (rb.missing) {
    findings.push(finding('robots.missing', 'access', 'low', 'small',
      'No robots.txt',
      'Without one, everything is allowed, which is fine. A robots.txt is still the standard place to point crawlers at your sitemap.',
      'Publish a short robots.txt that allows everything and lists your sitemap.',
      { fix_file: addFix({ id: 'robots', file: 'robots.txt', title: 'robots.txt', note: 'Upload as /robots.txt.',
        content: buildRobotsFile(null, { blocksAll: false }, sitemap && sitemap.ok ? sitemap.url : null) }) }));
  }
  if (!rb.missing && !rb.blocksAll && !rb.blockedSearch.length && robotsParsed) strengths.push('AI search crawlers are allowed');
  if (rb.blockedTraining.length && !rb.blockedSearch.length) {
    findings.push(finding('robots.blocks_ai_training', 'access', 'low', 'small',
      `You block AI training crawlers (${truncate(rb.blockedTraining.join(', '), 100)})`,
      'That keeps your content out of model training. AI search crawlers are still allowed, so assistants can quote you. This is a reasonable choice.',
      'Nothing to do unless you want to change the policy.'));
  }

  /* ---- 2. Rendering ---- */
  const rawWords = (rawDoc && rawDoc.wordCount) || 0;
  const renderedWords = (renderedDoc && renderedDoc.wordCount) || 0;
  // Small differences (cookie banners, widgets) are noise; only a real gap or an empty shell counts.
  const gap = renderedWords - rawWords;
  const shell = failed.has('diff.spa_shell') || (rawWords < 150 && renderedWords >= rawWords * 3 && gap >= 200);
  if (shell || (failed.has('diff.content') && gap >= 200)) {
    findings.push(finding('render.js_only', 'render', shell ? 'high' : 'medium', 'large',
      shell ? 'Most of the page only appears after JavaScript runs' : 'Part of the page only appears after JavaScript runs',
      `The raw HTML has about ${rawWords} words; the browser shows about ${renderedWords || 'many more'}. Most AI crawlers don't run JavaScript, so they see a near-empty page.`,
      'Turn on server-side rendering or pre-rendering in your framework (for example Next.js SSR/SSG, Nuxt SSR, or a pre-render service). At minimum, put the headline, services, contact details and prices in the HTML itself.'));
  } else if (headlessAvailable && rawWords >= 80) {
    strengths.push('the content is readable without JavaScript');
  }
  if (failed.has('diff.links')) {
    findings.push(finding('render.links', 'render', 'medium', 'medium',
      'Navigation links only exist after JavaScript runs',
      'Crawlers that don\'t run JavaScript can\'t follow them to your other pages.',
      'Render the main menu as plain <a href> links in the HTML.'));
  }

  /* ---- 3. Facts that disagree ---- */
  const phoneKeys = new Map();
  for (const p of facts.phones) { const k = phoneKey(p.value); if (k && !phoneKeys.has(k)) phoneKeys.set(k, p.value); }
  if (llms && llmsIsText) {
    for (const m of String(llms.text).matchAll(/(?:\+\d[\d\s().-]{7,}\d)/g)) {
      const k = phoneKey(m[0]); if (k && !phoneKeys.has(k)) phoneKeys.set(k, m[0].trim());
    }
  }
  if (phoneKeys.size > 1) {
    findings.push(finding('facts.phones', 'facts', 'medium', 'small',
      `${phoneKeys.size} different phone numbers across the page, schema and llms.txt`,
      `Found: ${truncate([...phoneKeys.values()].join(' · '), 160)}. If they're all current, fine. If one is old, assistants may quote the wrong one.`,
      'Keep one main number and use it everywhere: visible text, schema, llms.txt, Google Business Profile.'));
  }

  const schemaCountries = new Set(facts.areaServed.map(countryCode).filter(Boolean));
  if (schemaCountries.size && llms && llmsIsText) {
    const named = countriesNamedIn(llms.text);
    const onlySchema = [...schemaCountries].filter((c) => !named.has(c));
    if (named.size && onlySchema.length) {
      findings.push(finding('facts.area_served', 'facts', 'medium', 'small',
        'Your schema and llms.txt list different countries',
        `The schema's areaServed includes ${onlySchema.map((c) => COUNTRIES[c] || c).join(', ')}, which llms.txt doesn't mention. Machines can't tell which list is right.`,
        'Pick the true list and use it in both places, and on your contact or about page.'));
    }
  }
  if (facts.hours.length && !/\b(mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?|hours|open)\b/i.test(doc.text || '')) {
    findings.push(finding('facts.hours_hidden', 'facts', 'low', 'small',
      'Opening hours are only in hidden markup',
      'The schema has opening hours, but the page text never states them. Visitors can\'t see them, and Google prefers markup that matches visible text.',
      `Show the hours as text on the homepage or contact page: ${truncate(facts.hours.join('; '), 120)}.`));
  }

  /* ---- 4. Structured data ---- */
  const blocks = doc.jsonLd || [];
  if ((doc.jsonLdErrors || []).length) {
    findings.push(finding('schema.invalid', 'schema', 'high', 'small',
      'A structured-data block is broken JSON',
      `Search engines skip the whole block. Error: ${truncate(doc.jsonLdErrors[0], 140)}.`,
      'Paste the block into validator.schema.org, fix the reported line, and re-test.'));
  }
  if (!blocks.length) {
    findings.push(finding('schema.missing', 'schema', 'high', 'small',
      'No structured data (schema.org)',
      'Without it, search engines and assistants have to guess your name, contact details and what you offer from the prose.',
      'Add an Organization block to the homepage. The draft below uses only facts found on your page; add your address if customers visit you.',
      { fix_file: addFix({ id: 'schema_org', file: 'schema-organization.html', title: 'Organization schema',
        note: 'Paste into the homepage <head>. Change @type to LocalBusiness (or a type like Dentist, Plumber) if you serve a local area.',
        content: scriptTag(buildOrgSchema(facts, origin)) }) }));
  } else {
    strengths.push('structured data is present');
    const sp = schemaProblems(blocks);
    if (!facts.orgNodes.length) {
      findings.push(finding('schema.no_org', 'schema', 'medium', 'small',
        'Structured data doesn\'t describe the business itself',
        'There is schema on the page, but no Organization or LocalBusiness block with your name and contact details.',
        'Add the Organization block below alongside what you have.',
        { fix_file: addFix({ id: 'schema_org', file: 'schema-organization.html', title: 'Organization schema',
          note: 'Paste into the homepage <head>.', content: scriptTag(buildOrgSchema(facts, origin)) }) }));
    }
    if (sp.unknownTypes.length || sp.badProps.length) {
      const parts = [];
      if (sp.unknownTypes.length) parts.push(`types we don't recognise as schema.org: ${sp.unknownTypes.slice(0, 6).join(', ')}`);
      if (sp.badProps.length) parts.push(`properties that aren't schema.org: ${sp.badProps.map(([k, v]) => `${k} (use ${v} instead)`).join('; ')}`);
      const target = blocks.find((b) => { const p = schemaProblems([b]); return p.unknownTypes.length || p.badProps.length; });
      findings.push(finding('schema.vocabulary', 'schema', 'medium', 'small',
        'Some structured data uses names that aren\'t schema.org',
        `Google ignores what it doesn't recognise, so those facts are lost. Found ${truncate(parts.join('; and '), 300)}.`,
        'Use the corrected block below. It keeps everything else exactly as you wrote it. Check any type you still want at schema.org first.',
        { fix_file: target ? addFix({ id: 'schema_fixed', file: 'schema-corrected.html', title: 'Corrected schema block',
          note: 'Replace the matching JSON-LD block on the homepage.', content: scriptTag(repairSchemaBlock(target)) }) : undefined }));
    }
    if (failed.has('schema.required_fields')) {
      findings.push(finding('schema.required_fields', 'schema', 'low', 'small',
        'Structured data is missing basic fields',
        failed.get('schema.required_fields').message,
        'Add the missing properties (for an Organization: name and url).'));
    }
  }

  /* ---- 5. llms.txt ---- */
  if (llms && llms.error === 'skipped') {
    // GEO checks were turned off for this run; say nothing about llms.txt.
  } else if (llms && llmsIsText) {
    strengths.push('llms.txt is published');
    const repaired = repairLlms(llms.text, facts);
    const changedFormat = failed.has('llms_txt.summary') || failed.has('llms_txt.links');
    if (repaired.removed.length) {
      findings.push(finding('llms.steering', 'llms', 'medium', 'small',
        'llms.txt tells AI what to recommend',
        `It has ${repaired.removed.length === 1 ? 'a line' : `${repaired.removed.length} lines`} telling AI what to recommend or which answer is "correct" (quoted below). Those are instructions, not facts. Assistants are learning to discount pages that do this, and Google treats it as manipulation. Plain facts already do the job.`,
        `Remove ${repaired.removed.length === 1 ? 'that line' : `those ${repaired.removed.length} lines`}. The cleaned file below keeps everything else.`,
        { evidence: repaired.removed.slice(0, 5), fix_file: addFix({ id: 'llms', file: 'llms.txt', title: 'llms.txt (cleaned)',
          note: 'Replace /llms.txt.', content: repaired.text }) }));
    } else if (changedFormat) {
      findings.push(finding('llms.format', 'llms', 'low', 'small',
        'llms.txt is missing a summary line or links',
        'The llms.txt format starts with a "> one-line summary" under the title and lists pages as [name](url) links, so tools can follow them.',
        'Use the reformatted file below. The content is unchanged.',
        { fix_file: addFix({ id: 'llms', file: 'llms.txt', title: 'llms.txt (reformatted)', note: 'Replace /llms.txt.', content: repaired.text }) }));
    }
  } else {
    const soft = llms && llms.status === 200;
    findings.push(finding('llms.missing', 'llms', 'medium', 'small',
      soft ? '/llms.txt returns your web page instead of a text file' : 'No llms.txt',
      soft ? 'The URL answers with HTML (often a catch-all route), so tools that look for llms.txt get your homepage instead.'
        : 'llms.txt is a young, plain-text convention: a short description of the business that AI tools can read directly. It takes about 20 minutes.',
      'Publish the draft below at /llms.txt after filling in every TO CONFIRM line. Every line in it may be repeated to a customer, so only keep what\'s true.',
      { fix_file: addFix({ id: 'llms', file: 'llms.txt', title: 'llms.txt draft',
        note: 'Built only from facts found on your homepage. Fill in each TO CONFIRM.', content: buildLlmsDraft(facts, origin) }) }));
  }

  /* ---- 6. Titles, descriptions, headings, sitemap ---- */
  const page = (id, impact, title, why, fix) => findings.push(finding(id, 'meta', impact, 'small', title, why, fix));
  if (failed.has('title.present')) page('meta.title_missing', 'high', 'The homepage has no title', 'The title is the blue link in search results and the first thing assistants read.', 'Write a title under about 60 characters that says what you do and where: "Service in Place | Business Name".');
  else if (failed.has('title.length')) page('meta.title_length', 'low', 'The title is too long or too short', truncate(failed.get('title.length').message, 160), 'Aim for 50–60 characters: what you do and where, then your name.');
  if (failed.has('meta_description.present')) page('meta.description_missing', 'medium', 'No meta description', 'Search engines will pick a random sentence for the snippet under your link.', 'Write about 150 characters that say what you offer, where, and one reason to click.');
  else if (failed.has('meta_description.length')) page('meta.description_length', 'low', 'The meta description is too long or too short', truncate(failed.get('meta_description.length').message, 160), 'Aim for 140–160 characters.');
  if (failed.has('h1.present') || failed.has('headings.h1')) page('meta.h1', 'low', 'The page doesn\'t have exactly one main heading (H1)', truncate((failed.get('h1.present') || failed.get('headings.h1')).message, 160), 'Use one H1 that says what the business does.');
  if (failed.has('canonical.present')) page('meta.canonical', 'low', 'No canonical tag', 'It tells search engines which URL is the real one when the same page is reachable several ways.', `Add <link rel="canonical" href="${origin}/"> to the homepage <head>.`);
  if (failed.has('images.alt')) page('meta.alt', 'low', 'Some images have no alt text', truncate(failed.get('images.alt').message, 160), 'Describe what each image shows in a few words. Skip decorative images with alt="".');

  if (sitemap && !sitemap.ok) {
    findings.push(finding('sitemap.missing', 'meta', 'medium', 'small',
      'No sitemap.xml found',
      `${sitemap.url} ${sitemap.status ? `returned HTTP ${sitemap.status}` : 'could not be fetched'}${sitemap.status === 200 ? ' but isn\'t XML' : ''}. A sitemap is how search engines find every page quickly.`,
      'Most site builders and CMS plugins generate one. Publish it, list it in robots.txt, and submit it in Google Search Console.'));
  } else if (sitemap && sitemap.ok) {
    strengths.push(`sitemap.xml lists ${sitemap.locCount} URL${sitemap.locCount === 1 ? '' : 's'}`);
  }

  /* ---- 7. Content ---- */
  if (failed.has('eeat.thin_content') || (rawWords && Math.max(rawWords, renderedWords) < 250)) {
    findings.push(finding('content.thin', 'content', 'medium', 'large',
      'The homepage says very little',
      `About ${Math.max(rawWords, renderedWords)} words. There's not much for search engines or assistants to quote about what you do, where, and for how much.`,
      'Answer the questions customers actually ask: what you offer, where you work, typical prices, how to start. Short and specific beats long and vague.'));
  }
  if (failed.has('eeat.contact_info')) {
    findings.push(finding('content.contact', 'content', 'medium', 'small',
      'No contact details found on the homepage',
      'Customers and machines both look for a phone number, email or address on the homepage.',
      'Put at least one way to reach you in the header or footer of every page.'));
  }

  /* ---- 8. Spam-policy risk flags ---- */
  if (risk && risk.status && risk.status !== 'clean') {
    const top = (risk.flags || [])[0];
    findings.push(finding('risk.flags', 'other', risk.status === 'high' ? 'high' : 'medium', 'small',
      `Spam-policy risk: ${risk.flags.length} flag${risk.flags.length === 1 ? '' : 's'}`,
      top ? `${top.title}. Google's spam policies treat this as manipulation, whoever added it.` : 'See the risk flags section.',
      'See the risk flags section below for the evidence and the fix for each.'));
  }

  /* ---- 9. Everything else the engine failed (warnings and criticals only) ---- */
  const covered = new Set(['robots.noindex', 'server.x_robots_tag', 'geo.bot_wall', 'robots.ai_search_bots',
    'robots.ai_training_bots', 'robots.sitemap', 'diff.spa_shell', 'diff.content', 'diff.links', 'title.present',
    'title.length', 'meta_description.present', 'meta_description.length', 'h1.present', 'headings.h1',
    'canonical.present', 'images.alt', 'schema.present', 'schema.syntax', 'schema.primary_entity',
    'schema.required_fields', 'llms_txt.present', 'llms_txt.h1', 'llms_txt.summary', 'llms_txt.links',
    'llms_txt.markdown', 'eeat.thin_content', 'eeat.contact_info', 'server.status', 'scoring.critical_count',
    'scoring.overall']);
  for (const [id, c] of failed) {
    if (covered.has(id) || !['critical', 'warning'].includes(c.severity)) continue;
    const plain = PLAIN[id] || {};
    findings.push(finding(`engine.${id}`, plain.area || 'other', plain.impact || (c.severity === 'critical' ? 'medium' : 'low'),
      plain.effort || 'medium', plain.title || `Also flagged: ${c.label}`, truncate(c.message, 200),
      c.action || 'See the engine details below.'));
  }

  /* ---- Rank ---- */
  findings.sort((a, b) => (IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact]) || (a.tier - b.tier));
  const top = findings.slice(0, 5);
  const appendix = findings.slice(5);

  const notChecked = [
    'Whether Google has indexed the site and what people search to find it (connect Google Search Console).',
    'Your Google Business Profile and directory listings, which assistants read heavily.',
    'Real visitors\' page speed (Core Web Vitals field data from Search Console or PageSpeed Insights).',
    'Pages other than the homepage.',
    'What AI assistants actually say about you (ask them a customer\'s question once a month and note the answer).'
  ];
  if (!headlessAvailable) notChecked.unshift('How the page looks after JavaScript runs (the browser check was unavailable for this audit).');

  return {
    version: 1,
    summary: buildSummary(findings, strengths),
    headline: buildHeadline(findings),
    top,
    appendix,
    strengths,
    fixes,
    not_checked: notChecked,
    counts: {
      high: findings.filter((f) => f.impact === 'high').length,
      medium: findings.filter((f) => f.impact === 'medium').length,
      low: findings.filter((f) => f.impact === 'low').length
    }
  };
}

/** Plain-English titles for engine checks the advisor doesn't handle itself. */
const PLAIN = {
  'viewport.present': { title: 'No mobile viewport tag, so phones show a zoomed-out desktop page', impact: 'high', effort: 'small', area: 'meta' },
  'html.lang': { title: 'The page doesn\'t declare its language', impact: 'low', effort: 'small', area: 'meta' },
  'og.complete': { title: 'Link previews (Facebook, LinkedIn, chat apps) are incomplete', impact: 'low', effort: 'small', area: 'meta' },
  'social.image_reachable': { title: 'The link-preview image doesn\'t load', impact: 'low', effort: 'small', area: 'meta' },
  'twitter.card': { title: 'No X/Twitter card tags', impact: 'low', effort: 'small', area: 'meta' },
  'server.ttfb': { title: 'The server is slow to start responding', effort: 'medium' },
  'server.compression': { title: 'Pages are sent uncompressed', impact: 'low', effort: 'small' },
  'server.protocol': { title: 'The server uses old HTTP/1.1', effort: 'small' },
  'server.redirect_hops': { title: 'Too many redirects before the page loads', effort: 'small' },
  'eeat.https': { title: 'The site isn\'t fully on HTTPS', impact: 'high', effort: 'small', area: 'access' },
  'cwv.blocking_css': { title: 'Too many stylesheets hold up the first paint', effort: 'medium' },
  'cwv.blocking_scripts': { title: 'Scripts in <head> hold up the page', effort: 'small' },
  'cwv.lcp_lazy': { title: 'The main image is lazy-loaded, so it appears late', effort: 'small' },
  'cwv.image_dims': { title: 'Images without width and height make the page jump while loading', effort: 'small' },
  'cwv.oversize_assets': { title: 'Some files are very large', effort: 'medium' },
  'cwv.third_party_scripts': { title: 'Many third-party scripts slow the page', effort: 'medium' },
  'diff.js_errors': { title: 'JavaScript errors while the page loads', effort: 'medium', area: 'render' },
  'diff.headings': { title: 'Headings only appear after JavaScript runs', area: 'render' },
  'diff.critical_tags': { title: 'Title or meta tags change after JavaScript runs', area: 'render' },
  'diff.redirect_chain': { title: 'The browser goes through a chain of redirects', effort: 'small' },
  'dom.duplicate_ids': { title: 'Duplicate element IDs in the HTML', impact: 'low', effort: 'small' },
  'links.internal': { title: 'Few links from the homepage to your other pages', area: 'content' },
  'links.broken_external': { title: 'Broken links to other sites', effort: 'small' },
  'headings.hierarchy': { title: 'Heading levels skip around (H2 → H4)', impact: 'low', effort: 'small', area: 'meta' },
  'geo.noai': { title: 'A "noai" tag asks AI tools not to use the page', area: 'access', effort: 'small' },
  'geo.x_robots_tag_ai': { title: 'A server header asks AI tools not to use the page', area: 'access', effort: 'small' },
  'schema.entity_match': { title: 'Structured data doesn\'t match the visible page', area: 'schema', effort: 'small' }
};

function buildHeadline(findings) {
  const highs = findings.filter((f) => f.impact === 'high');
  let bad;
  if (!findings.length) bad = 'Nothing on this page needs fixing. Next: make sure you are listed on Google Business Profile and the directories your customers use.';
  else if (!highs.length) bad = `Nothing is blocking search engines or AI crawlers. The ${Math.min(findings.length, 5)} fixes below are improvements, most important first.`;
  else bad = `${highs.length === 1 ? 'One problem' : `${highs.length} problems`} to fix first, starting with: ${highs[0].title.charAt(0).toLowerCase()}${highs[0].title.slice(1)}.`;
  return bad;
}

function buildSummary(findings, strengths) {
  const good = strengths.length ? `What's working: ${strengths.slice(0, 3).join(', ')}.` : '';
  return [good, buildHeadline(findings)].filter(Boolean).join(' ');
}

module.exports = {
  buildAdvice, findSteering, analyzeRobots, buildRobotsFile, buildLlmsDraft, repairLlms,
  schemaProblems, repairSchemaBlock, extractFacts, KNOWN_TYPES, EFFORT_LABEL
};
