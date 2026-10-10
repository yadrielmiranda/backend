'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SOURCE_SHA, INPUT_SHA, COVERAGE_MESSAGE, validateSource, applyProfile } = require('./import-v026-pricing-ranges.cjs');
const { ruleKey } = require('./pricing-range-import-core.cjs');

function fixture(applied = false) {
  const ranges = [];
  for (let group = 0; group < 16; group++) {
    const count = group === 15 ? 26 : 18;
    for (let index = 0; index < count; index++) {
      ranges.push({ idSystem: 501 + group, idConfig: 701 + group, code: `G${group}_${index}`, isActive: true,
        rules: [{ idCrystal: 901 }, ...(group < 12 || (group === 12 && index < 6) ? [{ idCrystal: 902 }] : [])] });
    }
  }
  const keys = new Map(ranges.flatMap(range => range.rules.map(rule => {
    const data = { ...range, ...rule };
    return [ruleKey(data), { id: 1001 + ranges.indexOf(range) * 2 + rule.idCrystal, idSystem: data.idSystem, idConfig: data.idConfig, idCrystal: data.idCrystal }];
  })));
  const plan = {
    groups: Array.from({ length: 16 }, (_, index) => ({ idSystem: 501 + index, idConfig: 701 + index,
      brand: 'Eco Windows Systems', product: 'Fixed Window', system: index ? `Other ${index}` : 'Serie 70', configuration: 'Picture Window (O)' })),
    errors: [{ group: '501:701', message: COVERAGE_MESSAGE, examples: [{ width: '1', height: '1', matches: 0 }] }], warnings: [],
    directRulesToRemove: applied ? [] : [...keys.values()],
    summary: { inputRows: 518, groups: 16, ranges: 296, crystalRules: 518, createRanges: applied ? 0 : 296,
      unchangedRanges: applied ? 296 : 0, removeDirectRules: applied ? 0 : 29, errors: 1, warnings: 0 },
  };
  return { plan, ranges, proof: { group: '501:701', policyHash: 'reviewed-policy' } };
}

test('the dedicated profile resolves only the exact bounded Serie 70 finding', () => {
  const f = fixture();
  assert.equal(f.ranges.length, 296);
  assert.equal(f.ranges.reduce((sum, range) => sum + range.rules.length, 0), 518);
  applyProfile(f.plan, f.ranges, f.proof);
  assert.deepEqual(f.plan.errors, []);
  assert.equal(f.plan.resolvedCoverageFindings.length, 1);
  assert.deepEqual(f.plan.noaCoverageProof, f.proof);
  assert.equal(f.plan.summary.errors, 0);
});

test('a complete identical V026 import is a valid no-op', () => {
  const f = fixture(true);
  applyProfile(f.plan, f.ranges, f.proof);
  assert.deepEqual(f.plan.errors, []);
  assert.deepEqual(f.plan.directRulesToRemove, []);
});

test('an overlap and a different group coverage error are never suppressed', () => {
  const f = fixture();
  const overlap = { message: 'Ranges overlap, regardless of crystal.', range: '501:701:R1' };
  const otherCoverage = { message: COVERAGE_MESSAGE, group: '502:702' };
  f.plan.errors.push(overlap, otherCoverage);
  applyProfile(f.plan, f.ranges, f.proof);
  assert.deepEqual(f.plan.errors, [overlap, otherCoverage]);
  assert.equal(f.plan.summary.errors, 2);
});

for (const [label, change] of [
  ['wrong proof group', f => { f.proof.group = '502:702'; }],
  ['missing coverage finding', f => { f.plan.errors = []; }],
  ['duplicated coverage finding', f => { f.plan.errors.push({ ...f.plan.errors[0] }); }],
  ['same system name under another brand', f => { f.plan.groups[0].brand = 'Another brand'; }],
  ['same system name under another product', f => { f.plan.groups[0].product = 'Another product'; }],
]) {
  test(`rejects ${label}`, () => {
    const f = fixture();
    change(f);
    applyProfile(f.plan, f.ranges, f.proof);
    assert.ok(f.plan.errors.some(error => /does not resolve exactly/.test(error.message)));
    assert.equal(f.plan.noaCoverageProof, undefined);
  });
}

for (const [label, change] of [
  ['partial imported catalog', f => { f.plan.summary.createRanges--; f.plan.summary.unchangedRanges++; }],
  ['missing original general rule', f => { f.plan.directRulesToRemove.pop(); }],
  ['an extra original general rule', f => { f.plan.directRulesToRemove.push({ ...f.plan.directRulesToRemove[0], id: 999999 }); }],
  ['an unrelated general rule substituted into the deletion set', f => { f.plan.directRulesToRemove[0].idSystem = 999999; }],
  ['a general rule reappearing after import', f => { f.plan.summary.createRanges = 0; f.plan.summary.unchangedRanges = 296; }],
]) {
  test(`blocks ${label}`, () => {
    const f = fixture();
    change(f);
    applyProfile(f.plan, f.ranges, f.proof);
    assert.ok(f.plan.errors.some(error => /Partial or changed catalogs/.test(error.message)));
  });
}

test('altered expected counts and inactive ranges block the profile', () => {
  for (const change of [f => { f.plan.summary.crystalRules++; }, f => { f.ranges.pop(); }, f => { f.ranges[0].isActive = false; }]) {
    const f = fixture();
    change(f);
    applyProfile(f.plan, f.ranges, f.proof);
    assert.ok(f.plan.errors.some(error => /must resolve to exactly/.test(error.message)));
  }
});

test('billing or component-source warnings require a new review', () => {
  const f = fixture();
  const warning = { group: '502:702', message: 'Range selection uses existing billable dimension settings.' };
  f.plan.warnings.push(warning);
  applyProfile(f.plan, f.ranges, f.proof);
  assert.ok(f.plan.errors.some(error => /catalog warnings/.test(error.message)));
  assert.deepEqual(f.plan.warnings, [warning]);
});

test('a copied workbook hash cannot authorize altered prepared pricing data', () => {
  assert.match(SOURCE_SHA, /^[a-f0-9]{64}$/);
  assert.match(INPUT_SHA, /^[a-f0-9]{64}$/);
  const forged = { schemaVersion: 1, sourceSha256: SOURCE_SHA, rows: Array.from({ length: 518 }, (_, row) => ({ row, values: {} })) };
  assert.throws(() => validateSource(forged), /differs from the exact tested V026/);
  assert.throws(() => validateSource(null), /differs from the exact tested V026/);
});
