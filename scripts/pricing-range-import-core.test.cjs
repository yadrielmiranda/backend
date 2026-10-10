'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { buildPlan, contains, overlaps, coverage } = require('./pricing-range-import-core.cjs');

function catalog() {
  return {
    brands: [{ id: 1, name: 'Eco Windows Systems', isActive: true }],
    products: [{ id: 11, name: 'Fixed Window', kind: 'GLAZED_UNIT', pricingMode: 'AREA_PERIMETER', isActive: true }],
    systems: [{ id: 101, idBrand: 1, idProduct: 11, name: 'Serie 50', isActive: true }],
    configs: [{ id: 21, idProduct: 11, conf: 'Picture Window (O)', isActive: true }],
    sysConfs: [{
      idSystem: 101, idConfig: 21, pricingComponents: [], usedAsPricingSource: [],
      dimensionMode: 'STANDARD', billableHeightMode: 'ACTUAL_HEIGHT',
      minimumBillableWidthIn: null, minimumBillableHeightIn: null,
      billableHeightPercentOfWidth: null, billableHeightFixedIn: null,
      isSelectableInEstimate: true,
    }],
    crystals: [{ id: 7, glass: 'Glass A', isActive: true }, { id: 8, glass: 'Glass B', isActive: true }],
    systemCrystals: [{ idSystem: 101, idCrystal: 7 }, { idSystem: 101, idCrystal: 8 }],
    directRules: [],
    ranges: [],
    dimensionPrecision: ['minWidthIn', 'maxWidthIn', 'minHeightIn', 'maxHeightIn'].map(column => ({ column, precisionDigits: 11, scaleDigits: 4 })),
  };
}

function row(values = {}, rowNumber = 7) {
  return { row: rowNumber, values: {
    A: 'LOW', B: 'Eco Windows Systems', C: 'Fixed Window', D: 'Serie 50', E: 'Picture Window (O)', F: 'Glass A',
    G: '', H: 'Sí', I: '67.0625', J: 'Sí', K: '', L: 'Sí', M: '', N: 'Sí',
    O: '2.12345678901234567890', P: '3.45678901234567890123', Q: '100', R: '0', S: 'Sí', ...values,
  } };
}

function completeRows(crystals = ['Glass A']) {
  return crystals.flatMap((glass, index) => [
    row({ F: glass }, 7 + index * 2),
    row({ A: 'HIGH', F: glass, G: '67.0625', H: 'No', I: '', Q: '200', R: '1' }, 8 + index * 2),
  ]);
}

function input(rows = completeRows()) {
  return { schemaVersion: 1, sourceFileName: 'ranges.xlsx', sourceSha256: 'a'.repeat(64), sheetName: 'Pricing Ranges', rows };
}

function errorText(plan) {
  return plan.errors.map(error => error.message).join('\n');
}

function storedRange(range, id) {
  const { sourceRows, ...saved } = range;
  return { id, ...saved, rules: saved.rules.map((rule, index) => ({ id: id * 10 + index, rangeId: id, ...rule })) };
}

describe('four-decimal range boundaries', () => {
  it('preserves all four bound digits and twenty coefficient decimal digits', () => {
    const plan = buildPlan(input(), catalog());
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.rangesToCreate[0].maxWidthIn, '67.0625');
    assert.equal(plan.rangesToCreate[1].minWidthIn, '67.0625');
    assert.equal(plan.rangesToCreate[0].rules[0].costoA, '2.1234567890123456789');
    assert.equal(plan.rangesToCreate[0].rules[0].costoB, '3.45678901234567890123');
    assert.equal(plan.needsPrecisionMigration, false);
  });

  for (const [axis, minColumn, maxColumn, minInclusiveColumn] of [
    ['Width', 'G', 'I', 'H'], ['Height', 'K', 'M', 'L'],
  ]) {
    it(`keeps touching ${axis} boundaries distinct and gives the shared edge to exactly one range`, () => {
      const rows = axis === 'Width' ? completeRows() : [
        row({ I: '', M: '67.0625' }),
        row({ A: 'HIGH', I: '', K: '67.0625', L: 'No', R: '1' }, 8),
      ];
      const plan = buildPlan(input(rows), catalog());
      assert.deepEqual(plan.errors, []);
      const [low, high] = plan.rangesToCreate;
      assert.equal(overlaps(low, high), false);
      assert.equal(overlaps(high, low), false);
      for (const [value, expected] of [['67.0624', [true, false]], ['67.0625', [true, false]], ['67.0626', [false, true]]]) {
        const dimensions = axis === 'Width' ? [value, '24'] : ['24', value];
        assert.deepEqual([contains(low, ...dimensions), contains(high, ...dimensions)], expected);
      }
      assert.deepEqual(coverage([low, high]).gaps, []);

      const bothInclusive = structuredClone(rows);
      bothInclusive[1].values[minInclusiveColumn] = 'Sí';
      assert.match(errorText(buildPlan(input(bothInclusive), catalog())), /Ranges overlap, regardless of crystal/);

      const reversed = structuredClone(rows);
      reversed[1].values[minColumn] = '67.0626';
      reversed[1].values[maxColumn] = '67.0625';
      assert.match(errorText(buildPlan(input(reversed), catalog())), /Empty\/reversed/);
    });
  }

  it('detects the one-ten-thousandth gap rather than rounding the edges together', () => {
    const rows = completeRows();
    rows[1].values.G = '67.0626';
    const plan = buildPlan(input(rows), catalog());
    assert.match(errorText(plan), /do not uniquely cover all positive dimensions/);
    assert.ok(plan.errors.some(error => error.examples?.some(example => example.width === '67.06255' && example.matches === 0)));
  });

  for (const column of ['G', 'I', 'K', 'M']) {
    it(`rejects excess precision in ${column} without silently rounding`, () => {
      assert.match(errorText(buildPlan(input([row({ [column]: '67.06251' })]), catalog())), new RegExp(`${column}: invalid decimal precision`));
    });
  }

  it('requires the widening migration for old or incomplete bound precision', () => {
    const old = catalog();
    old.dimensionPrecision = old.dimensionPrecision.map(column => ({ ...column, precisionDigits: 10, scaleDigits: 3 }));
    assert.equal(buildPlan(input(), old).needsPrecisionMigration, true);
    const incomplete = catalog();
    incomplete.dimensionPrecision.pop();
    assert.equal(buildPlan(input(), incomplete).needsPrecisionMigration, true);
    const reducedIntegerCapacity = catalog();
    reducedIntegerCapacity.dimensionPrecision[0].precisionDigits = 10;
    assert.equal(buildPlan(input(), reducedIntegerCapacity).needsPrecisionMigration, true);
  });
});

describe('shared range parents and crystal rules', () => {
  it('groups two crystal rules under each shared range instead of creating ranges per crystal', () => {
    const plan = buildPlan(input(completeRows(['Glass A', 'Glass B'])), catalog());
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.summary.ranges, 2);
    assert.equal(plan.summary.crystalRules, 4);
    assert.deepEqual(plan.rangesToCreate.map(range => range.rules.map(rule => rule.idCrystal)), [[7, 8], [7, 8]]);
  });

  it('rejects parent-level overlaps even when the ranges use different crystals', () => {
    const rows = [row(), row({ A: 'OTHER', F: 'Glass B', G: '50', H: 'No', I: '' }, 8)];
    assert.match(errorText(buildPlan(input(rows), catalog())), /Ranges overlap, regardless of crystal/);
  });

  it('rejects duplicate range/crystal rows even if their coefficients are identical', () => {
    const rows = completeRows();
    rows.push({ ...structuredClone(rows[0]), row: 9 });
    const plan = buildPlan(input(rows), catalog());
    assert.ok(plan.errors.some(error => error.row === 9 && /Duplicate crystal/.test(error.message)));
  });

  for (const values of [{ I: '67.0624' }, { J: 'No' }, { R: '2' }, { S: 'No' }]) {
    it(`rejects inconsistent shared parent metadata ${JSON.stringify(values)}`, () => {
      const rows = completeRows(['Glass A', 'Glass B']);
      Object.assign(rows[2].values, values);
      assert.match(errorText(buildPlan(input(rows), catalog())), /Conflicting dimensions\/settings for LOW/);
    });
  }

  it('rejects a missing crystal rule in any range of the same group', () => {
    const rows = completeRows(['Glass A', 'Glass B']);
    rows.pop();
    assert.match(errorText(buildPlan(input(rows), catalog())), /same selected crystals/);
  });
});

describe('catalog resolution', () => {
  for (const [label, arrayName] of [
    ['Brand', 'brands'], ['Product', 'products'], ['System', 'systems'],
    ['Configuration', 'configs'], ['System/configuration association', 'sysConfs'], ['Crystal', 'crystals'],
  ]) {
    it(`rejects missing ${label} matches`, () => {
      const data = catalog();
      data[arrayName] = [];
      const errors = errorText(buildPlan(input(), data));
      assert.ok(errors.includes(label));
      assert.match(errors, /expected one catalog match, found 0/);
    });

    it(`rejects ambiguous ${label} matches`, () => {
      const data = catalog();
      const clone = structuredClone(data[arrayName][0]);
      if ('id' in clone) clone.id += 1000;
      data[arrayName].push(clone);
      if (arrayName === 'crystals') data.systemCrystals.push({ idSystem: 101, idCrystal: clone.id });
      const errors = errorText(buildPlan(input(), data));
      assert.ok(errors.includes(label));
      assert.match(errors, /expected one catalog match, found 2/);
    });
  }

  it('rejects a crystal that exists globally but is not associated with the chosen system', () => {
    const data = catalog();
    data.systemCrystals = data.systemCrystals.filter(crystal => crystal.idCrystal !== 7);
    assert.match(errorText(buildPlan(input(), data)), /Crystal Glass A: expected one catalog match, found 0/);
  });

  it('rejects an inactive associated crystal', () => {
    const data = catalog();
    data.crystals[0].isActive = false;
    assert.match(errorText(buildPlan(input(), data)), /Crystal Glass A: inactive catalog entry/);
  });

  it('accepts insignificant whitespace but does not invent case-insensitive name matches', () => {
    const rows = completeRows();
    rows[0].values.B = '  Eco  Windows\tSystems  ';
    assert.deepEqual(buildPlan(input(rows), catalog()).errors, []);
    rows[0].values.D = 'serie 50';
    assert.match(errorText(buildPlan(input(rows), catalog())), /System serie 50: expected one catalog match, found 0/);
  });

  it('rejects direct ranges on a component-priced parent', () => {
    const data = catalog();
    data.sysConfs[0].pricingComponents = [{ componentType: 'MAIN' }];
    assert.match(errorText(buildPlan(input(), data)), /Component-priced parent cannot receive direct ranges/);
  });
});

describe('replacement scope and repeatability', () => {
  it('identifies exactly 28 matching general rule IDs without including other crystals, configurations, or systems', () => {
    const data = catalog();
    const baseSystem = data.systems[0], baseSysConf = data.sysConfs[0];
    data.systems = [];
    data.sysConfs = [];
    data.systemCrystals = [];
    const rows = [], expectedIds = [];
    for (let index = 0; index < 14; index++) {
      const idSystem = 101 + index, name = `Serie ${index + 1}`;
      data.systems.push({ ...baseSystem, id: idSystem, name });
      data.sysConfs.push({ ...baseSysConf, idSystem });
      for (const idCrystal of [7, 8]) {
        data.systemCrystals.push({ idSystem, idCrystal });
        const id = 1000 + index * 2 + idCrystal - 7;
        expectedIds.push(id);
        data.directRules.push({ id, idSystem, idConfig: 21, idCrystal });
      }
      data.directRules.push({ id: 9000 + index, idSystem, idConfig: 21, idCrystal: 99 });
      data.directRules.push({ id: 9100 + index, idSystem, idConfig: 999, idCrystal: 7 });
      rows.push(...completeRows(['Glass A', 'Glass B']).map(item => ({ row: 7 + rows.length + item.row - 7, values: { ...item.values, D: name } })));
    }
    data.directRules.push({ id: 9200, idSystem: 999, idConfig: 21, idCrystal: 7 });
    const before = structuredClone({ rows, data });
    const plan = buildPlan(input(rows), data);
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.summary.removeDirectRules, 28);
    assert.deepEqual(plan.directRulesToRemove.map(rule => rule.id), expectedIds);
    assert.deepEqual(plan.groups.flatMap(group => group.directRulesToRemove), expectedIds);
    assert.deepEqual({ rows, data }, before, 'planning must not mutate the prepared rows or catalog');
  });

  it('preserves unrelated existing ranges and treats a repeated import as a no-op', () => {
    const data = catalog();
    data.directRules.push({ id: 100, idSystem: 101, idConfig: 21, idCrystal: 7 });
    const first = buildPlan(input(), data);
    assert.deepEqual(first.errors, []);
    const unrelated = storedRange({ ...first.rangesToCreate[0], idSystem: 999 }, 90);
    data.ranges = [unrelated];
    const withUnrelated = buildPlan(input(), data);
    assert.deepEqual(withUnrelated.errors, []);
    assert.equal(withUnrelated.summary.existingRangesPreserved, 1);
    assert.equal(withUnrelated.summary.createRanges, 2);
    data.ranges.push(...withUnrelated.rangesToCreate.map((range, index) => storedRange(range, 100 + index)));
    data.directRules = [];
    const second = buildPlan(input(), data);
    assert.deepEqual(second.errors, []);
    assert.deepEqual(second.rangesToCreate, []);
    assert.deepEqual(second.directRulesToRemove, []);
    assert.equal(second.unchangedRanges.length, 2);
    assert.equal(second.summary.existingRangesPreserved, 3);
    assert.deepEqual(data.ranges[0], unrelated);
    assert.equal(second.planHash, buildPlan(input(), data).planHash);
  });

  it('compares stored decimal values canonically when recognizing an unchanged range', () => {
    const data = catalog();
    data.ranges = buildPlan(input(), data).rangesToCreate.map((range, index) => storedRange(range, 100 + index));
    data.ranges[0].maxWidthIn = '67.062500';
    data.ranges[0].rules[0].costoC = '100.00000000000000000000';
    const plan = buildPlan(input(), data);
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.unchangedRanges.length, 2);
  });

  for (const change of ['bound', 'coefficient', 'crystal']) {
    it(`blocks a reused range code with a different ${change}`, () => {
      const data = catalog();
      const existing = storedRange(buildPlan(input(), data).rangesToCreate[0], 70);
      if (change === 'bound') existing.maxWidthIn = '67.0624';
      if (change === 'coefficient') existing.rules[0].costoC = '101';
      if (change === 'crystal') existing.rules[0].idCrystal = 8;
      data.ranges.push(existing);
      const snapshot = structuredClone(existing);
      assert.match(errorText(buildPlan(input(), data)), /Existing range code has different values; automatic replacement is disabled/);
      assert.deepEqual(existing, snapshot);
    });
  }

  it('blocks an overlapping existing active range even when its crystal is different', () => {
    const data = catalog();
    const existing = storedRange(buildPlan(input(), data).rangesToCreate[0], 70);
    existing.code = 'LEGACY';
    existing.rules[0].idCrystal = 8;
    data.ranges.push(existing);
    const plan = buildPlan(input(), data);
    assert.ok(plan.errors.some(error => error.existingId === 70 && error.message === 'Overlaps an existing active range.'));
  });

  it('preserves unrelated inactive ranges even when their dimensions overlap', () => {
    const data = catalog();
    const existing = storedRange(buildPlan(input(), data).rangesToCreate[0], 70);
    existing.code = 'OLD_INACTIVE';
    existing.isActive = false;
    data.ranges.push(existing);
    const plan = buildPlan(input(), data);
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.summary.existingRangesPreserved, 1);
    assert.equal(plan.summary.createRanges, 2);
  });
});
