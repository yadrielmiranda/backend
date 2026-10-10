'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { verifyNoaCoverage, resolvePlanRanges } = require('./v026-noa-coverage.cjs');

function fixture() {
  const policy = { id: 37, idSystem: 7, idConfig: 8, idCrystal: 1, isActive: true,
    idReinforcementOption: null, roundingRule: 'ROUND_UP_TO_NEXT', sizeBasis: 'FRAME',
    rules: ['12', '104'].flatMap(widthIn => ['12', '104'].map(heightIn => ({ widthIn, heightIn, ruleType: 'MAIN' }))) };
  const sysConf = { idSystem: 7, idConfig: 8, isSelectableInEstimate: true,
    dimensionMode: 'STANDARD', minimumBillableWidthIn: null, minimumBillableHeightIn: null,
    billableHeightMode: 'ACTUAL_HEIGHT', billableHeightPercentOfWidth: null, billableHeightFixedIn: null,
    requiresHeightLeft: false, requiresHeightRight: false, requiresLegHeight: false,
    requiresDoorWidth: false, requiresDoorHeight: false, requiresLeftSideliteWidth: false,
    requiresRightSideliteWidth: false, requiresLeftPanels: false, requiresRightPanels: false,
    requiresPanelCount: false, requiresHorizontalHeights: false, defaultReinforcementOptionId: null,
    pricingComponents: [], usedAsPricingSource: [] };
  const config = { id: 8, idProduct: 3, isActive: true, conf: 'Picture Window (O)', requiresHeightLeft: false,
    requiresHeightRight: false, requiresLegHeight: false, requiresSashHeight: false,
    requiresWindowHeight: false, fixedPanelCount: null };
  const range = { idSystem: 7, idConfig: 8, code: 'LEFT', minWidthIn: '12', maxWidthIn: '67.0625',
    minHeightIn: '12', maxHeightIn: '104', minWidthInclusive: true, maxWidthInclusive: true,
    minHeightInclusive: true, maxHeightInclusive: true, isActive: true, sortOrder: 0,
    rules: [{ idCrystal: 1, costoA: '1', costoB: '2', costoC: '3' }] };
  const state = { policies: [policy], reinforcementOptions: [], sysConf, config };
  const queries = [];
  const reader = key => ({ findMany: async query => { queries.push([key, query]); return state[key]; } });
  const single = key => ({ findUnique: async query => { queries.push([key, query]); return state[key]; } });
  return { state, queries, catalog: {
    brands: [{ id: 3, name: 'Eco Windows Systems', isActive: true }],
    products: [{ id: 3, name: 'Fixed Window', isActive: true, kind: 'GLAZED_UNIT',
      pricingMode: 'AREA_PERIMETER', diagramFamily: 'FIXED_SHAPE' }],
    systems: [{ id: 7, name: 'Serie 70', idBrand: 3, idProduct: 3, isActive: true }],
    configs: [{ id: 8, conf: 'Picture Window (O)', idProduct: 3, isActive: true }],
    crystals: [{ id: 1, glass: '3/16 Lam [1/8HS+.090PVB+1/8HS]', isActive: true }],
    systemCrystals: [{ idSystem: 7, idCrystal: 1 }], sysConfs: [structuredClone(sysConf)], ranges: [],
  },
    ranges: [range, { ...range, code: 'RIGHT', minWidthIn: '67.0625', maxWidthIn: '104', minWidthInclusive: false }],
    tx: { dimensionPolicy: reader('policies'), sysConfReinforcementOption: reader('reinforcementOptions'),
      sysConf: single('sysConf'), config: single('config') } };
}

const check = f => verifyNoaCoverage(f.tx, f.catalog, f.ranges);

test('proves the full continuous box, including an exact four-decimal boundary, without modifying inputs', async () => {
  const f = fixture();
  const before = JSON.stringify({ state: f.state, ranges: f.ranges, catalog: f.catalog });
  const evidence = await check(f);
  assert.equal(evidence.group, '7:8');
  assert.equal(evidence.noaPairCount, 4);
  assert.equal(evidence.coverageChecks, 15);
  assert.deepEqual(evidence.widthEdges, ['12', '67.0625', '104']);
  assert.deepEqual(evidence.domain, { minWidthIn: '12', maxWidthIn: '104', minHeightIn: '12', maxHeightIn: '104' });
  assert.match(evidence.proofHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify({ state: f.state, ranges: f.ranges, catalog: f.catalog }), before);
  assert.deepEqual(f.queries.find(([key]) => key === 'policies')[1].where,
    { idSystem: 7, idConfig: 8, idCrystal: 1, isActive: true });
  assert.equal(Object.hasOwn(f.queries.find(([key]) => key === 'policies')[1].where, 'idReinforcementOption'), false);
});

const refusals = [
  ['interior gap with all four NOA corner pairs still covered', f => { f.ranges[0].maxWidthIn = '66'; }, /pricing matches within the NOA box/],
  ['excluded shared boundary', f => { f.ranges[0].maxWidthInclusive = false; }, /67.0625 x 12 have 0/],
  ['overlapping shared boundary', f => { f.ranges[1].minWidthInclusive = true; }, /67.0625 x 12 have 2/],
  ['missing lower height edge', f => { for (const range of f.ranges) range.minHeightInclusive = false; }, /12 x 12 have 0/],
  ['missing upper width edge', f => { f.ranges[1].maxWidthInclusive = false; }, /104 x 12 have 0/],
  ['range extends outside the known domain', f => { f.ranges[1].maxWidthIn = '105'; }, /outside the verified NOA box/],
  ['unbounded range', f => { f.ranges[1].maxWidthIn = null; }, /maxWidthIn is missing/],
  ['inactive range', f => { f.ranges[0].isActive = false; }, /Inactive range/],
  ['unverified crystal', f => { f.ranges[0].rules.push({ idCrystal: 2 }); }, /unverified crystal set/],
  ['alternate active policy even for a reinforcement', f => { f.state.policies.push({ ...f.state.policies[0], id: 99, idReinforcementOption: 2 }); }, /exactly one active policy/],
  ['wrong policy group identity', f => { f.state.policies[0].idConfig = 38; }, /identity does not match/],
  ['allowed reinforcement option', f => { f.state.reinforcementOptions.push({ optionId: 2 }); }, /Reinforcement policies or options/],
  ['policy linked to reinforcement', f => { f.state.policies[0].idReinforcementOption = 2; }, /Reinforcement policies or options/],
  ['nearest rounding which can allow sizes above the last table row', f => { f.state.policies[0].roundingRule = 'NEAREST'; }, /round-up behavior/],
  ['unverified dimension basis', f => { f.state.policies[0].sizeBasis = 'GLASS'; }, /frame-dimension/],
  ['NOA domain changed', f => { f.state.policies[0].rules[0].widthIn = '11'; }, /NOA bounds are no longer/],
  ['non-MAIN dimension rule', f => { f.state.policies[0].rules[0].ruleType = 'SIDELITE'; }, /MAIN dimension rules/],
  ['duplicate dimension pair', f => { f.state.policies[0].rules.push({ ...f.state.policies[0].rules[0] }); }, /Duplicate NOA/],
  ['minimum billable dimension', f => { f.state.sysConf.minimumBillableWidthIn = '24'; }, /transforms dimensions/],
  ['percent-height billing', f => { f.state.sysConf.billableHeightMode = 'PERCENT_OF_WIDTH'; }, /transforms dimensions/],
  ['parent component pricing', f => { f.state.sysConf.pricingComponents.push({}); }, /uses components/],
  ['used as a component price source', f => { f.state.sysConf.usedAsPricingSource.push({}); }, /uses components/],
  ['complex dimension flags', f => { f.state.sysConf.requiresHorizontalHeights = true; }, /transforms dimensions/],
  ['derived or compound shape', f => { f.state.config.conf = 'Octagon'; }, /simple picture window/],
  ['extra required window height', f => { f.state.config.requiresWindowHeight = true; }, /simple picture window/],
  ['extra required sash height', f => { f.state.config.requiresSashHeight = true; }, /simple picture window/],
  ['wrong configuration product', f => { f.state.config.idProduct = 99; }, /simple picture window/],
  ['inactive live configuration', f => { f.state.config.isActive = false; }, /simple picture window/],
  ['stale catalogue billing', f => { f.catalog.sysConfs[0].minimumBillableWidthIn = '24'; }, /do not match/],
  ['stale catalogue complex flags', f => { f.catalog.sysConfs[0].requiresLegHeight = true; }, /do not match/],
  ['ambiguous brand', f => { f.catalog.brands.push({ ...f.catalog.brands[0], id: 5 }); }, /Brand: expected one/],
  ['ambiguous product', f => { f.catalog.products.push({ ...f.catalog.products[0], id: 5 }); }, /Product: expected one/],
  ['ambiguous system', f => { f.catalog.systems.push({ ...f.catalog.systems[0], id: 5 }); }, /System: expected one/],
  ['ambiguous configuration', f => { f.catalog.configs.push({ ...f.catalog.configs[0], id: 5 }); }, /Configuration: expected one/],
  ['ambiguous associated crystal', f => { f.catalog.crystals.push({ ...f.catalog.crystals[0], id: 5 });
    f.catalog.systemCrystals.push({ idSystem: 7, idCrystal: 5 }); }, /Crystal: expected one/],
  ['unknown product name', f => { f.catalog.products[0].name = 'Different Window'; }, /Product: expected one/],
  ['unknown brand name', f => { f.catalog.brands[0].name = 'Other Windows Systems'; }, /Brand: expected one/],
  ['wrong system brand association', f => { f.catalog.systems[0].idBrand = 99; }, /System: expected one/],
  ['wrong system product association', f => { f.catalog.systems[0].idProduct = 99; }, /System: expected one/],
  ['missing system configuration association', f => { f.catalog.sysConfs.length = 0; }, /system\/configuration association/],
  ['missing system crystal association', f => { f.catalog.systemCrystals.length = 0; }, /Crystal: expected one/],
  ['unsupported product pricing mode', f => { f.catalog.products[0].pricingMode = 'LINEAR'; }, /simple fixed-window pricing/],
  ['unsupported product kind', f => { f.catalog.products[0].kind = 'MATERIAL'; }, /simple fixed-window pricing/],
  ['unsupported diagram family', f => { f.catalog.products[0].diagramFamily = 'WINDOW_WALL'; }, /simple fixed-window pricing/],
  ['wrong crystal name', f => { f.catalog.crystals[0].glass = 'Other crystal'; }, /Crystal: expected one/],
  ...['brands', 'products', 'systems', 'configs', 'crystals'].map(key =>
    [`inactive ${key}`, f => { f.catalog[key][0].isActive = false; }, /not active/]),
];
for (const [name, modify, expected] of refusals) test(`refuses ${name}`, async () => {
  const f = fixture();
  modify(f);
  await assert.rejects(check(f), expected);
});

test('catalog and policy IDs may differ across databases without changing the verified semantics', async () => {
  const f = fixture();
  const c = f.catalog;
  c.brands[0].id = 103;
  c.products[0].id = 203;
  Object.assign(c.systems[0], { id: 307, idBrand: 103, idProduct: 203 });
  Object.assign(c.configs[0], { id: 408, idProduct: 203 });
  c.crystals[0].id = 501;
  Object.assign(c.systemCrystals[0], { idSystem: 307, idCrystal: 501 });
  Object.assign(c.sysConfs[0], { idSystem: 307, idConfig: 408 });
  Object.assign(f.state.sysConf, { idSystem: 307, idConfig: 408 });
  Object.assign(f.state.config, { id: 408, idProduct: 203 });
  Object.assign(f.state.policies[0], { id: 937, idSystem: 307, idConfig: 408, idCrystal: 501 });
  f.ranges.forEach(range => { range.idSystem = 307; range.idConfig = 408; range.rules = [{ idCrystal: 501 }]; });
  const proof = await check(f);
  assert.equal(proof.group, '307:408');
  assert.equal(proof.idCrystal, 501);
  assert.equal(proof.policyId, 937);
  assert.deepEqual(f.queries.find(([key]) => key === 'policies')[1].where,
    { idSystem: 307, idConfig: 408, idCrystal: 501, isActive: true });
  assert.deepEqual(f.queries.find(([key]) => key === 'config')[1].where, { id: 408 });
});

test('a changed positive policy ID is allowed; its verified conditions govern coverage', async () => {
  const f = fixture();
  f.state.policies[0].id = 987;
  assert.equal((await check(f)).policyId, 987);
});

test('same crystal label on an unrelated system does not create a false match', async () => {
  const f = fixture();
  f.catalog.crystals.push({ ...f.catalog.crystals[0], id: 9 });
  f.catalog.systemCrystals.push({ idSystem: 100, idCrystal: 9 });
  assert.equal((await check(f)).idCrystal, 1);
});

function planFixture() {
  const f = fixture();
  f.catalog.ranges = [{ ...structuredClone(f.ranges[1]), id: 22 }];
  const plan = { rangesToCreate: [f.ranges[0]], unchangedRanges: [{ id: 22, key: '7:8:RIGHT' }],
    summary: { ranges: 2, crystalRules: 2 } };
  return { ...f, plan };
}

test('reconstructs new and unchanged ranges for an idempotent full coverage proof without mutation', async () => {
  const f = planFixture();
  const before = JSON.stringify({ plan: f.plan, catalog: f.catalog });
  const resolved = resolvePlanRanges(f.plan, f.catalog);
  assert.equal((await verifyNoaCoverage(f.tx, f.catalog, resolved)).rangeCount, 2);
  assert.equal(JSON.stringify({ plan: f.plan, catalog: f.catalog }), before);
  assert.notEqual(resolved[0], f.plan.rangesToCreate[0]);
  assert.notEqual(resolved[1], f.catalog.ranges[0]);
});

test('fully unchanged import still reconstructs all ranges', async () => {
  const f = planFixture();
  f.catalog.ranges.push({ ...structuredClone(f.ranges[0]), id: 23 });
  f.plan.rangesToCreate = [];
  f.plan.unchangedRanges.push({ id: 23, key: '7:8:LEFT' });
  assert.equal((await verifyNoaCoverage(f.tx, f.catalog, resolvePlanRanges(f.plan, f.catalog))).rangeCount, 2);
});

const resolutionRefusals = [
  ['missing unchanged range', f => { f.catalog.ranges = []; }, /does not uniquely match/],
  ['same key but wrong ID', f => { f.plan.unchangedRanges[0].id = 30; }, /does not uniquely match/],
  ['same ID but wrong key', f => { f.plan.unchangedRanges[0].key = '7:8:OTHER'; }, /does not uniquely match/],
  ['duplicate catalog key', f => { f.catalog.ranges.push({ ...f.catalog.ranges[0], id: 30 }); }, /does not uniquely match/],
  ['duplicate catalog ID', f => { f.catalog.ranges.push({ ...f.catalog.ranges[0], code: 'OTHER' }); }, /does not uniquely match/],
  ['duplicate unchanged reference', f => { f.plan.unchangedRanges.push(f.plan.unchangedRanges[0]); }, /duplicate unchanged/],
  ['duplicate planned key', f => { f.plan.rangesToCreate.push(f.catalog.ranges[0]); }, /Duplicate resolved/],
  ['wrong range count', f => { f.plan.summary.ranges = 3; }, /counts do not match/],
  ['wrong rule count', f => { f.plan.summary.crystalRules = 3; }, /counts do not match/],
];
for (const [name, modify, expected] of resolutionRefusals) test(`range reconstruction refuses ${name}`, () => {
  const f = planFixture();
  modify(f);
  assert.throws(() => resolvePlanRanges(f.plan, f.catalog), expected);
});
