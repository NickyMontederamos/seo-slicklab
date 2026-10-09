'use strict';

/**
 * Rival gap analysis: turns one audit of your site plus audits of rival sites
 * into "where they beat you", "where nobody is doing it yet", and "where you lead".
 * Pure functions — no network — so they can be tested against saved audits.
 */

const SEVERITY_RANK = { critical: 3, warning: 2, notice: 1, info: 0 };
const SEVERITY_WEIGHT = { critical: 6, warning: 3, notice: 1, info: 1 };

/** Flatten an audit into { "module:checkId": check } for comparison. */
function indexChecks(audit) {
  const out = {};
  for (const [modKey, mod] of Object.entries(audit.modules || {})) {
    if (modKey === 'scoring_reporting') continue;
    for (const c of mod.checks || []) {
      if (c.status === 'skip') continue;
      out[`${modKey}:${c.id}`] = { ...c, module: modKey, moduleLabel: mod.label };
    }
  }
  return out;
}

/**
 * @param {{label:string,url:string,audit:object|null,error?:string}} you
 * @param {Array<{label:string,url:string,audit:object|null,error?:string}>} rivals
 */
function buildGapReport(you, rivals) {
  if (!you.audit) throw new Error(`Your site could not be audited: ${you.error || 'unknown error'}`);

  const audited = rivals.filter((r) => r.audit);
  const failed = rivals.filter((r) => !r.audit);
  const mine = indexChecks(you.audit);
  const theirs = audited.map((r) => ({ label: r.label, checks: indexChecks(r.audit) }));

  const gaps = [];        // you fail, at least one rival passes
  const openGround = [];  // you fail, every audited rival fails too
  const edges = [];       // you pass, at least one rival fails

  for (const [key, c] of Object.entries(mine)) {
    const compared = theirs.filter((t) => t.checks[key]);
    if (!compared.length) continue;
    const passing = compared.filter((t) => t.checks[key].status === 'pass').map((t) => t.label);
    const failing = compared.filter((t) => t.checks[key].status === 'fail').map((t) => t.label);

    // Severity is only recorded on failures, so take the worst one seen anywhere.
    const sev = [c, ...compared.map((t) => t.checks[key])]
      .filter((x) => x.status === 'fail')
      .map((x) => x.severity)
      .sort((a, b) => (SEVERITY_RANK[b] || 0) - (SEVERITY_RANK[a] || 0))[0] || 'notice';

    const row = {
      key, id: c.id, label: c.label, module: c.moduleLabel, severity: sev,
      your_message: c.message, action: c.action || null,
      rivals_passing: passing, rivals_failing: failing
    };

    if (c.status === 'fail' && passing.length) {
      gaps.push({ ...row, weight: (SEVERITY_WEIGHT[sev] || 1) * passing.length });
    } else if (c.status === 'fail' && !passing.length) {
      openGround.push({ ...row, weight: SEVERITY_WEIGHT[sev] || 1 });
    } else if (c.status === 'pass' && failing.length) {
      edges.push({ ...row, weight: (SEVERITY_WEIGHT[sev] || 1) * failing.length });
    }
  }

  const byWeight = (a, b) => b.weight - a.weight || (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  gaps.sort(byWeight); openGround.sort(byWeight); edges.sort(byWeight);

  const moduleKeys = Object.keys(you.audit.modules || {}).filter((k) => k !== 'scoring_reporting');
  const modules = moduleKeys.map((k) => ({
    key: k,
    label: you.audit.modules[k].label,
    you: you.audit.modules[k].score,
    rivals: Object.fromEntries(audited.map((r) => [r.label, r.audit.modules?.[k]?.score ?? null]))
  }));

  return {
    generated_at: new Date().toISOString(),
    you: siteSummary(you),
    rivals: audited.map(siteSummary),
    not_audited: failed.map((r) => ({ label: r.label, url: r.url, error: r.error || 'unknown error' })),
    modules,
    gaps, open_ground: openGround, edges
  };
}

function siteSummary(s) {
  const a = s.audit;
  return {
    label: s.label, url: s.url, final_url: a.final_url, http_status: a.http_status,
    overall_score: a.overall_score, grade: a.grade,
    ttfb_ms: a.fetch_timing?.ttfb_ms ?? null,
    headless: Boolean(a.fetch_timing?.headless_available)
  };
}

function cell(s) { return String(s == null ? '—' : s).replace(/\|/g, '\\|').replace(/\s+/g, ' '); }

/** Markdown for an MCP client or a report file. `limit` caps each list. */
function formatGapReport(report, limit = 10) {
  const L = [];
  const names = report.rivals.map((r) => r.label);

  L.push(`# Rival gap report — ${report.you.label}`);
  L.push('');
  L.push(`Compared against ${names.length} rival site${names.length === 1 ? '' : 's'}${names.length ? `: ${names.join(', ')}` : ''}.`);
  if (report.not_audited.length) {
    L.push(`Could not audit: ${report.not_audited.map((r) => `${r.label} (${r.error})`).join('; ')}.`);
  }
  L.push('');

  const section = (title, blurb, rows, who, last = 'Fix') => {
    L.push(`## ${title} (${rows.length})`);
    L.push(blurb);
    L.push('');
    if (!rows.length) { L.push('_None._'); L.push(''); return; }
    L.push(`| # | Check | Area | Severity | ${who} | ${last} |`);
    L.push('|---|---|---|---|---|---|');
    rows.slice(0, limit).forEach((g, i) => {
      const list = who === 'Rivals passing' ? g.rivals_passing : g.rivals_failing;
      const detail = last === 'Fix' ? g.action || g.your_message : g.your_message;
      L.push(`| ${i + 1} | ${cell(g.label)} | ${cell(g.module)} | ${g.severity} | ${cell(list.join(', '))} | ${cell(detail)} |`);
    });
    if (rows.length > limit) L.push(`\n_…${rows.length - limit} more in the JSON output._`);
    L.push('');
  };

  section('Where rivals beat you',
    'You fail these checks and at least one rival passes. Ranked by severity × number of rivals ahead of you.',
    report.gaps, 'Rivals passing');
  section('Open ground — nobody does this yet',
    'Every audited rival fails these too. Fixing one puts you ahead of the whole list.',
    report.open_ground, 'Rivals failing');
  section('Where you already lead',
    'You pass and at least one rival fails. Keep these from regressing.',
    report.edges, 'Rivals failing', 'Your result');

  L.push('## Engine scores');
  L.push('');
  L.push(`| Engine | You | ${names.map(cell).join(' | ')} |`);
  L.push(`|---|---|${names.map(() => '---').join('|')}${names.length ? '|' : ''}`);
  for (const m of report.modules) {
    L.push(`| ${cell(m.label)} | ${m.you} | ${names.map((n) => cell(m.rivals[n])).join(' | ')} |`);
  }
  L.push('');
  L.push('| Site | HTTP | TTFB ms | Overall | JS render checked |');
  L.push('|---|---|---|---|---|');
  for (const s of [report.you, ...report.rivals]) {
    L.push(`| ${cell(s.label)} | ${s.http_status} | ${cell(s.ttfb_ms)} | ${s.overall_score} (${cell(s.grade)}) | ${s.headless ? 'yes' : 'no'} |`);
  }
  L.push('');
  L.push('_Snapshot of public pages on ' + report.generated_at.slice(0, 10) + '. Scores move between runs; compare direction month to month._');
  return L.join('\n');
}

module.exports = { indexChecks, buildGapReport, formatGapReport };
