'use strict';

const { clean, evidence } = require('./untrusted.js');

const GOOGLE_SPAM_REPORT = 'https://developers.google.com/search/help/report-quality-issues';
const ICON = { critical: '🔴', warning: '🟡', notice: '🔵' };

/**
 * Markdown lines for one site's risk flags.
 * @param {object|null} risk  audit.risk (null when the risk engine was skipped)
 * @param {{title?:string, rival?:boolean, maxEvidence?:number}} opts
 */
function formatRisk(risk, { title = 'Risk flags', rival = false, maxEvidence = 3 } = {}) {
  const L = [];
  if (!risk) { L.push(`### ${clean(title)} — not checked`); return L; }
  L.push(`### ${clean(title)} — ${risk.status.toUpperCase()}`);
  if (!risk.flags.length) { L.push('No spam-policy or AI-manipulation red flags.'); return L; }
  for (const f of risk.flags) {
    L.push(`- ${ICON[f.severity] || ''} **[${f.severity}] ${clean(f.title, 120)}**`);
    for (const e of f.evidence.slice(0, maxEvidence)) L.push(`  - ${clean(e.where, 100)}: ${evidence(e.text)}`);
    L.push(`  - ${rival ? 'Context' : 'Fix'}: ${rival ? clean(f.detail, 220) : clean(f.action, 220)}`);
  }
  if (rival && risk.flags.some((f) => f.severity !== 'notice')) {
    L.push(`- If this is a real policy violation, report it to Google: ${GOOGLE_SPAM_REPORT}`);
  }
  return L;
}

module.exports = { formatRisk, GOOGLE_SPAM_REPORT };
