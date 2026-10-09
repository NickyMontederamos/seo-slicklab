'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildGapReport, formatGapReport } = require('../mcp/lib/compare.js');

const chk = (id, status, severity = 'warning') => ({ id, label: id, status, severity: status === 'fail' ? severity : 'info', message: `${id} ${status}`, action: `fix ${id}` });
const audit = (checks, score = 50) => ({
  final_url: 'https://x/', http_status: 200, overall_score: score, grade: 'C',
  fetch_timing: { ttfb_ms: 100, headless_available: false },
  modules: {
    schema_rich: { key: 'schema_rich', label: 'Schema', score, checks },
    scoring_reporting: { key: 'scoring_reporting', label: 'Scoring', score, checks: [chk('scoring.overall', 'fail', 'critical')] }
  }
});

test('classifies gaps, open ground and edges', () => {
  const you = { label: 'You', url: 'https://you/', audit: audit([
    chk('schema.present', 'fail', 'critical'),
    chk('faq', 'fail', 'notice'),
    chk('llms', 'pass'),
    chk('skipped', 'skip')
  ]) };
  const rivals = [
    { label: 'A', url: 'https://a/', audit: audit([chk('schema.present', 'pass'), chk('faq', 'fail', 'notice'), chk('llms', 'fail', 'warning')]) },
    { label: 'B', url: 'https://b/', audit: audit([chk('schema.present', 'pass'), chk('faq', 'fail', 'notice'), chk('llms', 'pass')]) },
    { label: 'C', url: 'https://c/', audit: null, error: 'timeout' }
  ];
  const r = buildGapReport(you, rivals);

  assert.deepEqual(r.gaps.map((g) => g.id), ['schema.present']);
  assert.deepEqual(r.gaps[0].rivals_passing, ['A', 'B']);
  assert.equal(r.gaps[0].weight, 12); // critical (6) x 2 rivals ahead
  assert.deepEqual(r.open_ground.map((g) => g.id), ['faq']);
  assert.deepEqual(r.edges.map((g) => g.id), ['llms']);
  assert.equal(r.edges[0].severity, 'warning', 'severity comes from the rival failure');
  assert.deepEqual(r.not_audited, [{ label: 'C', url: 'https://c/', error: 'timeout' }]);
  assert.ok(!JSON.stringify(r).includes('scoring.overall'), 'scoring module is excluded');

  const md = formatGapReport(r);
  assert.match(md, /## Where rivals beat you \(1\)/);
  assert.match(md, /Could not audit: C \(timeout\)/);
});

test('throws when your own site failed', () => {
  assert.throws(() => buildGapReport({ label: 'You', url: 'u', audit: null, error: 'DNS' }, []), /DNS/);
});
