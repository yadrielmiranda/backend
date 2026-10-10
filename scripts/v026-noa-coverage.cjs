'use strict';

// Import evidence only. This does not change the application's dimension validation.
const { Prisma } = require('@prisma/client');
const { contains, hash, canonicalRange, rangeKey } = require('./pricing-range-import-core.cjs');
const D = Prisma.Decimal.clone({ precision: 50 });
const TARGET = Object.freeze({ brand: 'Eco Windows Systems', product: 'Fixed Window', system: 'Serie 70',
  config: 'Picture Window (O)', crystal: '3/16 Lam [1/8HS+.090PVB+1/8HS]' });
const norm = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
const COMPLEX_FLAGS = ['requiresHeightLeft', 'requiresHeightRight', 'requiresLegHeight',
  'requiresDoorWidth', 'requiresDoorHeight', 'requiresLeftSideliteWidth', 'requiresRightSideliteWidth',
  'requiresLeftPanels', 'requiresRightPanels', 'requiresPanelCount', 'requiresHorizontalHeights'];
const BILLING_FIELDS = ['dimensionMode', 'minimumBillableWidthIn', 'minimumBillableHeightIn',
  'billableHeightMode', 'billableHeightPercentOfWidth', 'billableHeightFixedIn', 'isSelectableInEstimate'];
const CONFIG_COMPLEX_FLAGS = ['requiresHeightLeft', 'requiresHeightRight', 'requiresLegHeight',
  'requiresSashHeight', 'requiresWindowHeight'];

function requireCondition(condition, message) {
  if (!condition) throw new Error(`V026 NOA coverage proof refused: ${message}`);
}

function uniqueActive(rows, label) {
  requireCondition(rows.length === 1, `${label}: expected one catalog match, found ${rows.length}.`);
  requireCondition(rows[0].isActive === true, `${label}: catalog entry is not active.`);
  requireCondition(Number.isSafeInteger(rows[0].id) && rows[0].id > 0, `${label}: invalid catalog ID.`);
  return rows[0];
}

function resolveTarget(catalog) {
  for (const key of ['brands', 'products', 'systems', 'configs', 'crystals', 'sysConfs', 'systemCrystals']) {
    requireCondition(Array.isArray(catalog[key]), `Missing catalog ${key}.`);
  }
  const brand = uniqueActive(catalog.brands.filter(row => norm(row.name) === TARGET.brand), 'Brand');
  const product = uniqueActive(catalog.products.filter(row => norm(row.name) === TARGET.product), 'Product');
  requireCondition(product.kind === 'GLAZED_UNIT' && product.pricingMode === 'AREA_PERIMETER' &&
    product.diagramFamily === 'FIXED_SHAPE', 'The product no longer has simple fixed-window pricing semantics.');
  const system = uniqueActive(catalog.systems.filter(row => row.idBrand === brand.id && row.idProduct === product.id &&
    norm(row.name) === TARGET.system), 'System');
  const config = uniqueActive(catalog.configs.filter(row => row.idProduct === product.id &&
    norm(row.conf) === TARGET.config), 'Configuration');
  const associations = catalog.sysConfs.filter(row => row.idSystem === system.id && row.idConfig === config.id);
  requireCondition(associations.length === 1, 'Expected one system/configuration association.');
  const associatedIds = new Set(catalog.systemCrystals.filter(row => row.idSystem === system.id).map(row => row.idCrystal));
  const crystal = uniqueActive(catalog.crystals.filter(row => associatedIds.has(row.id) &&
    norm(row.glass) === TARGET.crystal), 'Crystal');
  requireCondition(catalog.systemCrystals.filter(row => row.idSystem === system.id && row.idCrystal === crystal.id).length === 1,
    'Expected one system/crystal association.');
  return { brand, product, system, config, crystal, sysConf: associations[0] };
}

// The generic plan keeps complete data for new ranges, but only identity references
// for unchanged ones. Reconstruct both sets so a repeated import proves all ranges.
function resolvePlanRanges(plan, catalog) {
  requireCondition(Array.isArray(plan.rangesToCreate) && Array.isArray(plan.unchangedRanges) &&
    Array.isArray(catalog.ranges), 'Expected complete plan and catalog ranges.');
  const seen = new Set();
  const add = range => {
    requireCondition(range && Number.isSafeInteger(range.idSystem) && range.idSystem > 0 &&
      Number.isSafeInteger(range.idConfig) && range.idConfig > 0 && typeof range.code === 'string' &&
      /^[A-Z0-9_-]{1,30}$/.test(range.code) && Array.isArray(range.rules) && range.rules.length > 0,
    'Invalid resolved plan range.');
    const key = rangeKey(range);
    requireCondition(!seen.has(key), `Duplicate resolved plan range ${key}.`);
    seen.add(key);
    return canonicalRange(range);
  };
  const resolved = plan.rangesToCreate.map(add);
  const ids = new Set();
  for (const reference of plan.unchangedRanges) {
    requireCondition(reference && Number.isSafeInteger(reference.id) && reference.id > 0 &&
      typeof reference.key === 'string' && !ids.has(reference.id), 'Invalid or duplicate unchanged range reference.');
    ids.add(reference.id);
    const byId = catalog.ranges.filter(range => range.id === reference.id);
    const byKey = catalog.ranges.filter(range => rangeKey(range) === reference.key);
    requireCondition(byId.length === 1 && byKey.length === 1 && byId[0] === byKey[0],
      `Unchanged range ${reference.key} does not uniquely match its catalog ID.`);
    resolved.push(add(byId[0]));
  }
  requireCondition(plan.summary && resolved.length === plan.summary.ranges &&
    resolved.reduce((count, range) => count + range.rules.length, 0) === plan.summary.crystalRules,
  'Resolved range/rule counts do not match the plan.');
  return resolved;
}

function decimal(value, label) {
  requireCondition(value != null && value !== '', `${label} is missing.`);
  const result = new D(value);
  requireCondition(result.isFinite() && result.gt(0), `${label} must be finite and positive.`);
  return result;
}

function clippedAxisProbes(ranges, axis) {
  const edges = new Map(['12', '104'].map(v => [v, new D(v)]));
  for (const range of ranges) for (const end of ['min', 'max']) {
    const field = `${end}${axis}In`;
    const edge = decimal(range[field], field);
    requireCondition(edge.gte(12) && edge.lte(104), `${field} is outside the verified NOA box.`);
    requireCondition(typeof range[`${end}${axis}Inclusive`] === 'boolean', `Invalid ${end}${axis}Inclusive.`);
    edges.set(edge.toFixed(), edge);
  }
  const sorted = [...edges.values()].sort((a, b) => a.comparedTo(b));
  const probes = [];
  for (let index = 0; index < sorted.length; index++) {
    if (index) probes.push(sorted[index - 1].plus(sorted[index]).div(2).toFixed());
    probes.push(sorted[index].toFixed());
  }
  return { edges: sorted.map(v => v.toFixed()), probes };
}

async function verifyNoaCoverage(tx, catalog, ranges) {
  requireCondition(Array.isArray(ranges), 'Expected resolved pricing ranges.');
  const target = resolveTarget(catalog);
  const group = { idSystem: target.system.id, idConfig: target.config.id };
  const idCrystal = target.crystal.id;
  const groupRanges = ranges.filter(r => r.idSystem === group.idSystem && r.idConfig === group.idConfig);
  requireCondition(groupRanges.length > 0, 'The target group has no ranges.');
  for (const range of groupRanges) {
    requireCondition(range.isActive === true, `Inactive range ${range.code}.`);
    requireCondition(Array.isArray(range.rules) && range.rules.length === 1 && range.rules[0].idCrystal === idCrystal,
      `Range ${range.code} has an unverified crystal set.`);
    for (const axis of ['Width', 'Height']) {
      requireCondition(decimal(range[`min${axis}In`], `min${axis}In`).lte(decimal(range[`max${axis}In`], `max${axis}In`)),
        `Range ${range.code} has reversed bounds.`);
    }
  }

  // Query all active alternatives for this crystal, not just a first matching policy.
  const [policies, reinforcementOptions, sysConf, config] = await Promise.all([
    tx.dimensionPolicy.findMany({ where: { ...group, idCrystal, isActive: true }, include: { rules: true }, orderBy: { id: 'asc' } }),
    tx.sysConfReinforcementOption.findMany({ where: group, select: { optionId: true } }),
    tx.sysConf.findUnique({ where: { idSystem_idConfig: group }, include: { pricingComponents: true, usedAsPricingSource: true } }),
    tx.config.findUnique({ where: { id: group.idConfig }, select: { id: true, conf: true, idProduct: true, isActive: true,
      requiresHeightLeft: true, requiresHeightRight: true, requiresLegHeight: true, requiresSashHeight: true,
      requiresWindowHeight: true, fixedPanelCount: true } }),
  ]);
  requireCondition(policies.length === 1, 'Expected exactly one active policy for the target crystal.');
  const policy = policies[0];
  requireCondition(Number.isSafeInteger(policy.id) && policy.id > 0 && policy.idSystem === group.idSystem &&
    policy.idConfig === group.idConfig && policy.idCrystal === idCrystal && policy.isActive === true,
    'The NOA policy identity does not match the resolved active catalog group.');
  requireCondition(policy.idReinforcementOption == null && reinforcementOptions.length === 0,
    'Reinforcement policies or options require a separate proof.');
  requireCondition(policy.roundingRule === 'ROUND_UP_TO_NEXT' && policy.sizeBasis === 'FRAME',
    'The policy does not use the verified frame-dimension / round-up behavior.');
  requireCondition(Array.isArray(policy.rules) && policy.rules.length > 0 && policy.rules.every(r => r.ruleType === 'MAIN'),
    'Expected only nonempty MAIN dimension rules.');
  requireCondition(sysConf && sysConf.idSystem === group.idSystem && sysConf.idConfig === group.idConfig &&
    sysConf.dimensionMode === 'STANDARD' && sysConf.billableHeightMode === 'ACTUAL_HEIGHT' &&
    sysConf.minimumBillableWidthIn == null && sysConf.minimumBillableHeightIn == null &&
    sysConf.billableHeightPercentOfWidth == null && sysConf.billableHeightFixedIn == null &&
    sysConf.isSelectableInEstimate === true && sysConf.defaultReinforcementOptionId == null &&
    Array.isArray(sysConf.pricingComponents) && sysConf.pricingComponents.length === 0 &&
    Array.isArray(sysConf.usedAsPricingSource) && sysConf.usedAsPricingSource.length === 0 &&
    COMPLEX_FLAGS.every(field => sysConf[field] === false),
  'The configuration transforms dimensions, uses components, or is not selectable.');
  requireCondition(config && config.id === group.idConfig && config.idProduct === target.product.id && config.isActive === true &&
    norm(config.conf) === TARGET.config && CONFIG_COMPLEX_FLAGS.every(field => config[field] === false) &&
    config.fixedPanelCount == null, 'The configuration is no longer the verified simple picture window.');
  requireCondition([...BILLING_FIELDS, ...COMPLEX_FLAGS, 'defaultReinforcementOptionId', 'pricingComponents', 'usedAsPricingSource']
    .every(field => JSON.stringify(target.sysConf[field]) === JSON.stringify(sysConf[field])),
  'Catalog billing settings do not match the live configuration.');

  const ruleDimensions = policy.rules.map(rule => ({
    width: decimal(rule.widthIn, 'NOA width').toFixed(), height: decimal(rule.heightIn, 'NOA height').toFixed(),
  })).sort((a, b) => new D(a.width).comparedTo(b.width) || new D(a.height).comparedTo(b.height));
  const uniquePairs = new Set(ruleDimensions.map(rule => `${rule.width}:${rule.height}`));
  requireCondition(uniquePairs.size === ruleDimensions.length, 'Duplicate NOA dimension pairs.');
  const domain = {};
  for (const [axis, member] of [['Width', 'width'], ['Height', 'height']]) {
    const values = ruleDimensions.map(rule => new D(rule[member]));
    domain[`min${axis}In`] = D.min(...values).toFixed();
    domain[`max${axis}In`] = D.max(...values).toFixed();
    requireCondition(domain[`min${axis}In`] === '12' && domain[`max${axis}In`] === '104',
      `The ${axis.toLowerCase()} NOA bounds are no longer exactly 12 to 104 inches.`);
  }

  const widths = clippedAxisProbes(groupRanges, 'Width');
  const heights = clippedAxisProbes(groupRanges, 'Height');
  let coverageChecks = 0;
  for (const width of widths.probes) for (const height of heights.probes) {
    const hits = groupRanges.filter(range => contains(range, width, height));
    requireCondition(hits.length === 1, `Dimensions ${width} x ${height} have ${hits.length} pricing matches within the NOA box.`);
    coverageChecks++;
  }

  // An axis-aligned range's membership is constant in every open cell. Testing each
  // boundary and one interior point per cell proves the entire continuous box, so
  // the proof includes all allowed eighth-inch inputs between the NOA table pairs.
  // ROUND_UP_TO_NEXT rejects below either minimum and cannot select any rule above
  // either maximum; therefore every dimension the current policy accepts is in it.
  const evidence = {
    group: `${group.idSystem}:${group.idConfig}`, idCrystal, policyId: policy.id, roundingRule: policy.roundingRule,
    sizeBasis: policy.sizeBasis, domain, domainInclusive: true, rangeCount: groupRanges.length,
    noaPairCount: ruleDimensions.length, noaDimensionPairsSha256: hash(ruleDimensions),
    proof: 'Every point of the closed continuous NOA bounding box has exactly one active pricing range; all measurements accepted by the unchanged ROUND_UP_TO_NEXT policy are inside this box.',
    widthEdges: widths.edges, heightEdges: heights.edges,
    coverageChecks, unmatchedPoints: 0, overlappingPoints: 0,
  };
  return { ...evidence, proofHash: hash(evidence) };
}

module.exports = { verifyNoaCoverage, resolvePlanRanges };
