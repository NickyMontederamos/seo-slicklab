'use strict';

/**
 * "Am I on the map?" — Google Places API (New) Text Search, the official, allowed way
 * to read local results. Needs PLACES_API_KEY (restrict it to Places API (New)).
 *
 * Caveat stated in every report: API order approximates, but is not identical to,
 * the Maps app list, which also depends on the searcher's location and history.
 */

const { clean } = require('./untrusted.js');

const ENDPOINT = () => `${process.env.PLACES_API_BASE || 'https://places.googleapis.com'}/v1/places:searchText`;
const FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.rating', 'places.userRatingCount',
  'places.websiteUri', 'places.primaryTypeDisplayName', 'places.googleMapsUri', 'places.businessStatus'
].join(',');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

function isYou(place, { business_name: name, website }) {
  const site = website ? hostOf(/^https?:/i.test(website) ? website : `https://${website}`) : null;
  if (site && hostOf(place.websiteUri) === site) return true;
  const a = norm(place.displayName?.text);
  const b = norm(name);
  return Boolean(b) && (a === b || a.startsWith(`${b} `) || a.includes(` ${b} `) || a.endsWith(` ${b}`));
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {{query:string, business_name:string, website?:string, lat?:number, lng?:number, radius_m?:number}} p
 */
async function localPackCheck(p) {
  const key = process.env.PLACES_API_KEY;
  if (!key) throw new Error('PLACES_API_KEY is not set. Create a key with Places API (New) enabled.');
  const body = { textQuery: p.query, pageSize: 20 };
  if (typeof p.lat === 'number' && typeof p.lng === 'number') {
    body.locationBias = { circle: { center: { latitude: p.lat, longitude: p.lng }, radius: p.radius_m || 5000 } };
  }
  const res = await fetch(ENDPOINT(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Places API: ${data.error?.message || `HTTP ${res.status}`}`);
  return summarize(p, data.places || []);
}

function summarize(p, places) {
  const list = places.map((pl, i) => ({
    position: i + 1,
    name: pl.displayName?.text || '(unnamed)',
    rating: pl.rating ?? null,
    reviews: pl.userRatingCount ?? 0,
    website: pl.websiteUri || null,
    address: pl.formattedAddress || null,
    maps_url: pl.googleMapsUri || null,
    status: pl.businessStatus || null,
    you: isYou(pl, p)
  }));
  const me = list.find((x) => x.you) || null;
  const reviews = list.filter((x) => !x.you).map((x) => x.reviews);
  return {
    query: p.query, checked_at: new Date().toISOString(),
    found: Boolean(me), position: me ? me.position : null, total: list.length,
    your_listing: me,
    review_median: median(reviews),
    listings_under_5_reviews: list.filter((x) => !x.you && x.reviews < 5).length,
    without_website: list.filter((x) => !x.website).length,
    list
  };
}

function formatLocalPack(r, name) {
  const L = [];
  L.push(`# Map results — "${clean(r.query, 120)}"`);
  L.push('');
  if (r.found) {
    L.push(`**${clean(name, 80)} is #${r.position} of ${r.total}.** ${r.your_listing.reviews} reviews` +
      `${r.your_listing.rating != null ? `, ${r.your_listing.rating}★` : ''}.`);
  } else {
    L.push(`**${clean(name, 80)} is not in the top ${r.total}.** A verified Google Business Profile in the matching category is the entry ticket.`);
  }
  L.push(`Median reviews among the others: ${r.review_median}. ${r.listings_under_5_reviews} listing(s) have fewer than 5 reviews; ${r.without_website} have no website.`);
  if (r.found && r.your_listing.reviews < r.review_median) {
    L.push(`Reaching the median takes about ${Math.ceil(r.review_median - r.your_listing.reviews)} more genuine reviews.`);
  }
  L.push('');
  L.push('| # | Business | Rating | Reviews | Website |');
  L.push('|---|---|---|---|---|');
  for (const x of r.list) {
    L.push(`| ${x.position} | ${x.you ? '**' : ''}${clean(x.name, 70)}${x.you ? '** (you)' : ''} | ${x.rating ?? '—'} | ${x.reviews} | ${x.website ? clean(hostOf(x.website) || x.website, 50) : '—'} |`);
  }
  L.push('');
  L.push('_From the official Places API. The Maps app list also depends on where the searcher is, so treat positions as close, not exact. Track the trend month to month._');
  return L.join('\n');
}

module.exports = { localPackCheck, summarize, formatLocalPack, isYou, median };
