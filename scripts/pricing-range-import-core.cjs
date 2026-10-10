'use strict';

const { createHash } = require('node:crypto');
const { Prisma } = require('@prisma/client');
const D = Prisma.Decimal.clone({ precision: 50 });
const bounds = ['minWidthIn', 'maxWidthIn', 'minHeightIn', 'maxHeightIn'];
const shared = ['idSystem', 'idConfig', 'code', ...bounds, 'minWidthInclusive', 'maxWidthInclusive', 'minHeightInclusive', 'maxHeightInclusive', 'sortOrder', 'isActive'];
const norm = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const numeric = value => value == null || value === '' ? null : new D(value).toFixed();
const groupKey = value => `${value.idSystem}:${value.idConfig}`;
const ruleKey = value => `${groupKey(value)}:${value.idCrystal}`;
const rangeKey = value => `${groupKey(value)}:${value.code.toUpperCase()}`;

function flag(value, label) {
  const text = norm(value).toLowerCase();
  if (['', 'sí', 'si', 'yes', 'true', '1'].includes(text)) return true;
  if (['no', 'false', '0'].includes(text)) return false;
  throw new Error(`${label}: invalid yes/no value.`);
}

function number(value, label, coefficient = false) {
  const text = norm(value);
  if (!coefficient && !text) return null;
  const pattern = coefficient ? /^-?\d{1,4}(?:\.\d{1,20})?$/ : /^\d{1,7}(?:\.\d{1,4})?$/;
  if (!pattern.test(text)) throw new Error(`${label}: invalid decimal precision.`);
  const decimal = new D(text);
  if (!coefficient && !decimal.gt(0)) throw new Error(`${label}: must be greater than zero.`);
  return decimal.toFixed();
}

function axisOverlaps(a, b, axis) {
  const min = `min${axis}In`, max = `max${axis}In`, mi = `min${axis}Inclusive`, ma = `max${axis}Inclusive`;
  const before = (first, second) => first[max] != null && second[min] != null &&
    (new D(first[max]).lt(second[min]) || (new D(first[max]).eq(second[min]) && !(first[ma] && second[mi])));
  return !before(a, b) && !before(b, a);
}

function overlaps(a, b) {
  return axisOverlaps(a, b, 'Width') && axisOverlaps(a, b, 'Height');
}

function contains(range, width, height) {
  return [['Width', width], ['Height', height]].every(([axis, value]) => {
    const v = new D(value), min = range[`min${axis}In`], max = range[`max${axis}In`];
    return (min == null || v.gt(min) || (v.eq(min) && range[`min${axis}Inclusive`])) &&
      (max == null || v.lt(max) || (v.eq(max) && range[`max${axis}Inclusive`]));
  });
}

function rangeData(range) {
  return Object.fromEntries(shared.map(key => [key, bounds.includes(key) ? numeric(range[key]) : range[key]]));
}

function ruleData(rule) {
  return { idCrystal: rule.idCrystal, costoA: numeric(rule.costoA), costoB: numeric(rule.costoB), costoC: numeric(rule.costoC) };
}

function canonicalRange(range) {
  return { ...rangeData(range), rules: range.rules.map(ruleData).sort((a, b) => a.idCrystal - b.idCrystal) };
}

function axisProbes(ranges, axis) {
  const edges = [...new Set(ranges.flatMap(r => [r[`min${axis}In`], r[`max${axis}In`]]).filter(v => v != null))].map(v => new D(v)).sort((a, b) => a.comparedTo(b));
  const probes = [];
  let prev = new D(0);
  for (const edge of edges) {
    if (edge.gt(prev)) probes.push(prev.plus(edge).div(2).toFixed());
    if (edge.gt(0)) probes.push(edge.toFixed());
    prev = edge;
  }
  probes.push(prev.plus(1).toFixed());
  return probes;
}

function coverage(ranges) {
  const gaps = [];
  let checks = 0;
  for (const w of axisProbes(ranges, 'Width')) for (const h of axisProbes(ranges, 'Height')) {
    checks++;
    const hits = ranges.filter(r => r.isActive && contains(r, w, h));
    if (hits.length !== 1 && gaps.length < 5) gaps.push({ width: w, height: h, matches: hits.length });
  }
  return { checks, gaps };
}

function buildPlan(input, catalog) {
  if (input.schemaVersion !== 1 || !Array.isArray(input.rows) || !input.rows.length || !/^[a-f0-9]{64}$/.test(input.sourceSha256)) throw new Error('Invalid prepared workbook JSON.');
  const errors = [], warnings = [], grouped = new Map(), contexts = new Map();
  const unique = (rows, label) => {
    if (rows.length !== 1) throw new Error(`${label}: expected one catalog match, found ${rows.length}.`);
    if (rows[0].isActive === false) throw new Error(`${label}: inactive catalog entry.`);
    return rows[0];
  };
  for (const row of input.rows) {
    try {
      const v = row.values;
      for (const key of 'ABCDEF') if (!norm(v[key])) throw new Error(`${key}: required value is blank.`);
      const brand = unique(catalog.brands.filter(x => norm(x.name) === norm(v.B)), `Brand ${v.B}`);
      const product = unique(catalog.products.filter(x => norm(x.name) === norm(v.C)), `Product ${v.C}`);
      const system = unique(catalog.systems.filter(x => x.idBrand === brand.id && x.idProduct === product.id && norm(x.name) === norm(v.D)), `System ${v.D}`);
      const config = unique(catalog.configs.filter(x => x.idProduct === product.id && norm(x.conf) === norm(v.E)), `Configuration ${v.E}`);
      const sysConf = unique(catalog.sysConfs.filter(x => x.idSystem === system.id && x.idConfig === config.id), 'System/configuration association');
      if (product.kind !== 'GLAZED_UNIT' || product.pricingMode !== 'AREA_PERIMETER') throw new Error('Product does not support area/perimeter range pricing.');
      if (sysConf.pricingComponents.length) throw new Error('Component-priced parent cannot receive direct ranges.');
      const associatedIds = new Set(catalog.systemCrystals.filter(x => x.idSystem === system.id).map(x => x.idCrystal));
      const crystal = unique(catalog.crystals.filter(x => associatedIds.has(x.id) && norm(x.glass) === norm(v.F)), `Crystal ${v.F}`);
      const code = norm(v.A).toUpperCase();
      if (!/^[A-Z0-9_-]{1,30}$/.test(code)) throw new Error('Invalid range code.');
      const sortOrder = norm(v.R) || '0';
      if (!/^\d+$/.test(sortOrder) || Number(sortOrder) > 2147483647) throw new Error('Invalid sort order.');
      const range = { idSystem: system.id, idConfig: config.id, code,
        minWidthIn: number(v.G, 'G'), minWidthInclusive: flag(v.H, 'H'), maxWidthIn: number(v.I, 'I'), maxWidthInclusive: flag(v.J, 'J'),
        minHeightIn: number(v.K, 'K'), minHeightInclusive: flag(v.L, 'L'), maxHeightIn: number(v.M, 'M'), maxHeightInclusive: flag(v.N, 'N'),
        sortOrder: Number(sortOrder), isActive: flag(v.S, 'S') };
      if (bounds.every(key => range[key] == null)) throw new Error('At least one dimension bound is required.');
      for (const axis of ['Width', 'Height']) {
        const lo = range[`min${axis}In`], hi = range[`max${axis}In`];
        if (lo != null && hi != null && (new D(lo).gt(hi) || (new D(lo).eq(hi) && !(range[`min${axis}Inclusive`] && range[`max${axis}Inclusive`])))) throw new Error(`Empty/reversed ${axis} interval.`);
      }
      const rule = { idCrystal: crystal.id, costoA: number(v.O, 'O', true), costoB: number(v.P, 'P', true), costoC: number(v.Q, 'Q', true) };
      const key = rangeKey(range);
      if (!grouped.has(key)) grouped.set(key, { ...range, rules: [], sourceRows: [] });
      const parent = grouped.get(key);
      if (JSON.stringify(rangeData(parent)) !== JSON.stringify(rangeData(range))) throw new Error(`Conflicting dimensions/settings for ${code}.`);
      if (parent.rules.some(r => r.idCrystal === crystal.id)) throw new Error(`Duplicate crystal in ${code}.`);
      parent.rules.push(rule);
      parent.sourceRows.push(row.row);
      contexts.set(groupKey(range), { idSystem: system.id, idConfig: config.id, brand: brand.name, product: product.name, system: system.name, configuration: config.conf,
        billing: Object.fromEntries(['dimensionMode', 'minimumBillableWidthIn', 'minimumBillableHeightIn', 'billableHeightMode', 'billableHeightPercentOfWidth', 'billableHeightFixedIn', 'isSelectableInEstimate'].map(k => [k, sysConf[k]])),
        usedAsPricingSource: sysConf.usedAsPricingSource,
      });
    } catch (error) {
      errors.push({ row: row.row, message: error.message });
    }
  }
  const ranges = [...grouped.values()].sort((a, b) => a.idSystem - b.idSystem || a.idConfig - b.idConfig || a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  for (const range of ranges) range.rules.sort((a, b) => a.idCrystal - b.idCrystal);
  const groups = [...contexts.values()];
  let coverageChecks = 0;
  for (const group of groups) {
    const rs = ranges.filter(r => groupKey(r) === groupKey(group));
    const crystalIds = [...new Set(rs.flatMap(r => r.rules.map(x => x.idCrystal)))].sort((a, b) => a - b);
    for (const r of rs) if (JSON.stringify(r.rules.map(x => x.idCrystal)) !== JSON.stringify(crystalIds)) errors.push({ range: rangeKey(r), message: 'Every range in a group must contain the same selected crystals.' });
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      if (rs[i].isActive && rs[j].isActive && overlaps(rs[i], rs[j])) errors.push({ range: rangeKey(rs[i]), otherRange: rangeKey(rs[j]), message: 'Ranges overlap, regardless of crystal.' });
    }
    const covered = coverage(rs);
    coverageChecks += covered.checks;
    if (covered.gaps.length) errors.push({ group: groupKey(group), message: 'Active ranges do not uniquely cover all positive dimensions; review coverage before replacing the general rules.', examples: covered.gaps });
    group.rangeCount = rs.length;
    group.ruleCount = rs.reduce((n, r) => n + r.rules.length, 0);
    group.crystals = crystalIds.map(id => ({ id, glass: catalog.crystals.find(c => c.id === id).glass }));
    if (group.usedAsPricingSource.length) warnings.push({ group: groupKey(group), message: 'This configuration is a pricing source for components.', sources: group.usedAsPricingSource });
    const b = group.billing;
    if (b.minimumBillableWidthIn != null || b.minimumBillableHeightIn != null || b.billableHeightMode !== 'ACTUAL_HEIGHT' || b.dimensionMode !== 'STANDARD') warnings.push({ group: groupKey(group), message: 'Range selection uses existing billable dimension settings.', billing: b });
  }
  const create = [], unchanged = [];
  for (const range of ranges) {
    const existing = catalog.ranges.filter(r => rangeKey(r) === rangeKey(range));
    if (existing.length) {
      if (existing.length === 1 && JSON.stringify(canonicalRange(existing[0])) === JSON.stringify(canonicalRange(range))) unchanged.push({ id: existing[0].id, key: rangeKey(range) });
      else errors.push({ range: rangeKey(range), message: 'Existing range code has different values; automatic replacement is disabled.' });
    } else create.push(range);
    for (const old of catalog.ranges) if (groupKey(old) === groupKey(range) && rangeKey(old) !== rangeKey(range) && old.isActive && range.isActive && overlaps(old, range)) errors.push({ range: rangeKey(range), existingId: old.id, existingCode: old.code, message: 'Overlaps an existing active range.' });
  }
  const affectedKeys = new Set(ranges.flatMap(r => r.rules.map(rule => ruleKey({ ...r, ...rule }))));
  const directRulesToRemove = catalog.directRules.filter(r => affectedKeys.has(ruleKey(r)));
  for (const group of groups) group.directRulesToRemove = directRulesToRemove.filter(r => groupKey(r) === groupKey(group)).map(r => r.id);
  const needsPrecisionMigration = catalog.dimensionPrecision.length !== 4 || catalog.dimensionPrecision.some(c => Number(c.scaleDigits) < 4 || Number(c.precisionDigits) - Number(c.scaleDigits) < 7);
  const plan = { version: 1, source: { name: input.sourceFileName, sha256: input.sourceSha256, sheet: input.sheetName }, catalogHash: hash(catalog), groups, rangesToCreate: create, unchangedRanges: unchanged, directRulesToRemove, errors, warnings, needsPrecisionMigration,
    summary: { inputRows: input.rows.length, groups: groups.length, ranges: ranges.length, crystalRules: ranges.reduce((n, r) => n + r.rules.length, 0), createRanges: create.length, unchangedRanges: unchanged.length, removeDirectRules: directRulesToRemove.length, existingRangesPreserved: catalog.ranges.length, coverageChecks, errors: errors.length, warnings: warnings.length },
  };
  plan.planHash = hash(plan);
  return plan;
}

module.exports = { buildPlan, hash, rangeData, ruleData, canonicalRange, overlaps, contains, coverage, bounds, groupKey, ruleKey, rangeKey };
