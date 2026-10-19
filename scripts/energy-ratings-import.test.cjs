'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planImport, compositionKey, sourceOptions } = require('./energy-ratings-import-core.cjs');
const { applyPlan, argumentsFor } = require('./import-energy-ratings.cjs');
const source = require('../data/energy-ratings-nfrc-v0.9.json');

function fixture() {
  const row = structuredClone(source.rows.find(item => item.sourceRow === 92));
  const catalog = {
    brands: [{ id: 3, name: 'Eco Windows Systems', isActive: true }],
    products: [{ id: 1, name: 'Single Hung Window', diagramFamily: 'SINGLE_HUNG', isActive: true }],
    systems: [{ id: 2, name: 'Serie 100', idBrand: 3, idProduct: 1, isActive: true }],
    configs: [{ id: 1, conf: 'XO', idProduct: 1, isActive: true }],
    crystals: [{ id: 2, glass: '7/16 Lam [3/16 HS + 0.090 PVB + 3/16 HS]', isActive: true }],
    systemCrystals: [{ idSystem: 2, idCrystal: 2 }], sysConfs: [{ idSystem: 2, idConfig: 1 }],
    tints: [{ id: 1, color: 'Clear', isActive: true, isGlobal: true }],
    coatings: [{ id: 1, name: 'LowE SB70', isActive: true, isGlobal: true }, { id: 2, name: 'None', isActive: true, isGlobal: true }],
    privacies: [{ id: 1, name: 'Clear', isActive: true }, { id: 2, name: 'White', isActive: true }],
    brandTints: [{ idBrand: 3, idTint: 1 }], brandCoatings: [{ idBrand: 3, idCoating: 1 }, { idBrand: 3, idCoating: 2 }], brandPrivacies: [{ idBrand: 3, idPrivacy: 1 }, { idBrand: 3, idPrivacy: 2 }],
  };
  return { catalog, input: { ...source, rows: [row] }, row };
}

test('extract preserves workbook count, missing product boundary and decimal provenance', () => {
  assert.equal(Object.hasOwn(source, 'units'), false);
  assert.equal(source.rows.length, 976);
  assert.equal(source.rows.filter(row => ['uFactor', 'shgc', 'vlt'].every(key => /^\d+(?:\.\d+)?$/.test(row[key] || ''))).length, 750);
  assert.equal(source.rows.filter(row => row.sourceRow >= 422 && row.sourceRow <= 437 && row.productLabel === '').length, 16);
  assert.equal(source.rows.find(row => row.sourceRow === 664).brandLabel, 'ECO WINDOW');
  assert.equal(source.rows.find(row => row.sourceRow === 704).brandLabel, 'ECO NOVO');
  assert.equal(source.rows.find(row => row.sourceRow === 10).vlt, '0.72099999999999997');
});

test('maps exact existing IDs without storing source metadata or mutating the catalog', () => {
  const { catalog, input } = fixture();
  const before = JSON.stringify(catalog);
  const plan = planImport(input, catalog);
  assert.equal(plan.ready.length, 1);
  assert.deepEqual([plan.ready[0].idSystem, plan.ready[0].idCrystal, plan.ready[0].idTint, plan.ready[0].idCoating, plan.ready[0].idPrivacy, plan.ready[0].idConfig], [2, 2, 1, 2, 1, 1]);
  assert.equal(plan.ready[0].uFactor, '1.075000');
  assert.equal(plan.ready[0].activeKey, '2:2:1:2:1:1');
  for (const field of ['sourceFile', 'sourceSheet', 'sourceRow', 'sourceVersion', 'sourceGlassId', 'composition', 'notes', 'units']) {
    assert.equal(Object.hasOwn(plan.ready[0], field), false);
  }
  assert.equal(plan.summary.mappedSourceRows, 1);
  assert.equal(JSON.stringify(catalog), before);
});

test('does not equate material, gas, treatments, pane order or unknown treatment', () => {
  assert.notEqual(compositionKey('3/16 HS + 0.09 PVB + 3/16 HS'), compositionKey('3/16 HS + 0.09 SGP + 3/16 HS'));
  assert.notEqual(compositionKey('3/16 TEMP + 5/16 AIR + 3/16 HS + .090 PVB + 3/16 HS'), compositionKey('3/16 TEMP + 5/16 ARG + 3/16 HS + .090 PVB + 3/16 HS'));
  assert.notEqual(compositionKey('3/16 HS + .090 PVB + 3/16 HS'), compositionKey('3/16 ANN + .090 PVB + 3/16 ANN'));
  assert.notEqual(compositionKey('1/8 TEMP + 1/4 AIR + 3/16 HS + .090 PVB + 3/16 HS'), compositionKey('3/16 HS + .090 PVB + 3/16 HS + 1/4 AIR + 1/8 TEMP'));
  assert.equal(compositionKey('3/16 CLEAR + .090 PVB + 3/16 CLEAR'), null);
  assert.equal(compositionKey('1/8 CLEAR FT + 1/4 AIR + 3/16 CLEAR HS + .090 PVB + 3/16 CLEAR HS'), '1/8TEMP+1/4AIR+3/16HS+0.09PVB+3/16HS');
});

test('conflicting source labels and unassociated privacy never receive guessed values', () => {
  assert.throws(() => sourceOptions(source.rows.find(row => row.sourceRow === 889)), /SOURCE_TINT_CONFLICT/);
  assert.throws(() => sourceOptions(source.rows.find(row => row.sourceRow === 924)), /SOURCE_PRIVACY_CONFLICT/);
  const { catalog, input } = fixture();
  input.rows[0] = structuredClone(source.rows.find(row => row.sourceRow === 93));
  catalog.brandPrivacies = [{ idBrand: 3, idPrivacy: 1 }];
  const plan = planImport(input, catalog);
  assert.equal(plan.ready.length, 0);
  assert.match(plan.rejected[0].reason, /PRIVACIES_UNAVAILABLE/);
});

test('missing values stay unavailable and zero SHGC/VLT remain valid', () => {
  const { catalog, input } = fixture();
  input.rows[0].uFactor = null;
  assert.equal(planImport(input, catalog).rejected[0].reason, 'SOURCE_METRICS_MISSING');
  input.rows[0].uFactor = '1.075';
  input.rows[0].shgc = '0';
  input.rows[0].vlt = '0';
  assert.equal(planImport(input, catalog).ready[0].vlt, '0.000000');
});

test('a global coating still requires its brand association', () => {
  const { catalog, input } = fixture();
  catalog.brandCoatings = [];
  const plan = planImport(input, catalog);
  assert.equal(plan.ready.length, 0);
  assert.match(plan.rejected[0].reason, /COATINGS_UNAVAILABLE/);
});

test('different coating surfaces are ambiguous even if only one variant has numeric values', () => {
  const { catalog, input } = fixture();
  const coated = structuredClone(source.rows.find(row => row.sourceRow === 94));
  input.rows = [coated, { ...coated, sourceRow: 2000, composition: coated.composition.replace('SURF#2', 'SURF#4'), uFactor: null, shgc: null, vlt: null }];
  const plan = planImport(input, catalog);
  assert.equal(plan.ready.length, 0);
  assert.equal(plan.rejected.find(row => row.sourceRow === 94).reason, 'SOURCE_PHYSICAL_VARIANTS_REQUIRE_REVIEW');
});

test('different tint ply placements cannot collapse to a single tint selection', () => {
  const { catalog, input } = fixture();
  catalog.tints.push({ id: 2, color: 'Grey', isActive: true, isGlobal: true });
  catalog.brandTints.push({ idBrand: 3, idTint: 2 });
  const grey = structuredClone(source.rows.find(row => row.sourceRow === 96));
  const reversed = { ...grey, sourceRow: 2000, composition: '3/16" CLEAR HS + 0.09 PVB + 3/16" GREY HS' };
  input.rows = [grey, reversed];
  const plan = planImport(input, catalog);
  assert.equal(plan.ready.length, 0);
  assert.ok(plan.rejected.every(row => row.reason === 'SOURCE_PHYSICAL_VARIANTS_REQUIRE_REVIEW'));
});

test('nominal catalog mismatch is quarantined rather than silently repairing catalog', () => {
  const { catalog, input } = fixture();
  catalog.crystals[0].glass = '3/16 Lam [3/16 HS + 0.090 PVB + 3/16 HS]';
  assert.equal(planImport(input, catalog).rejected[0].reason, 'CRYSTAL_NOMINAL_THICKNESS_CONFLICT');
});

test('multiple configurations require explicit scope and never get broad scope by default', () => {
  const { catalog, input } = fixture();
  catalog.configs.push({ id: 2, conf: 'XOX', idProduct: 1, isActive: true });
  catalog.sysConfs.push({ idSystem: 2, idConfig: 2 });
  assert.equal(planImport(input, catalog).rejected[0].reason, 'CONFIG_SCOPE_REQUIRES_REVIEW');
  const explicit = planImport(input, catalog, { configScopes: { '100 SINGLE HUNG': { configNames: ['XO'], reason: 'Verified exact config' } } });
  assert.equal(explicit.ready[0].idConfig, 1);
  assert.equal(explicit.ready[0].appliesToAllConfigs, false);
  const broad = planImport(input, catalog, { configScopes: { '100 SINGLE HUNG': { allConfigs: true, reason: 'Manufacturer confirmed all configured operations' } } });
  assert.equal(broad.ready[0].idConfig, null);
  assert.equal(broad.ready[0].appliesToAllConfigs, true);
});

test('confirmed pending-config scope preserves single configs, explicit scopes and other validations', () => {
  const { catalog, input } = fixture();
  const options = { includePendingConfigs: true };
  assert.deepEqual(planImport(input, catalog, options), planImport(input, catalog));
  catalog.configs.push({ id: 2, conf: 'XOX', idProduct: 1, isActive: true });
  catalog.sysConfs.push({ idSystem: 2, idConfig: 2 });
  assert.equal(planImport(input, catalog).rejected[0].reason, 'CONFIG_SCOPE_REQUIRES_REVIEW');
  const plan = planImport(input, catalog, options);
  assert.equal(plan.ready.length, 1);
  assert.equal(plan.ready[0].idConfig, null);
  assert.equal(plan.ready[0].appliesToAllConfigs, true);
  assert.equal(plan.ready[0].activeKey, '2:2:1:2:1:*');
  assert.equal(plan.ready[0].uFactor, '1.075000');
  const explicit = planImport(input, catalog, { ...options, configScopes: { '100 SINGLE HUNG': { configNames: ['XO'], reason: 'Confirmed selection' } } });
  assert.equal(explicit.ready[0].idConfig, 1);
  input.rows[0].uFactor = '-';
  assert.equal(planImport(input, catalog, options).rejected[0].reason, 'SOURCE_METRICS_MISSING');
  input.rows[0].uFactor = '1.075';
  catalog.systemCrystals = [];
  assert.match(planImport(input, catalog, options).rejected[0].reason, /CRYSTAL_UNAVAILABLE/);
});

test('confirmed pending-config scope requires an available configuration', () => {
  const { catalog, input } = fixture();
  catalog.sysConfs = [];
  const plan = planImport(input, catalog, { includePendingConfigs: true });
  assert.equal(plan.ready.length, 0);
  assert.equal(plan.rejected[0].reason, 'CONFIG_SCOPE_REQUIRES_REVIEW');
});

test('375 picture and shapes never share a configuration and unknown shape names remain excluded', () => {
  const { catalog, input } = fixture();
  catalog.brands = [{ id: 4, name: 'Eco Novo Systems', isActive: true }];
  catalog.products[0].diagramFamily = 'FIXED_SHAPE';
  catalog.systems[0] = { ...catalog.systems[0], name: 'Serie 375', idBrand: 4 };
  catalog.crystals[0].glass = '9/16 Lam [1/4 ANN + 0.090 PVB + 1/4 ANN]';
  catalog.configs = [
    { id: 8, conf: 'Picture Window (O)', idProduct: 1, isActive: true },
    { id: 9, conf: 'Tombstone', idProduct: 1, isActive: true },
    { id: 99, conf: 'Unverified new shape', idProduct: 1, isActive: true },
  ];
  catalog.sysConfs = catalog.configs.map(config => ({ idSystem: 2, idConfig: config.id }));
  for (const name of ['brandTints', 'brandCoatings', 'brandPrivacies']) catalog[name].forEach(row => { row.idBrand = 4; });
  input.rows = [structuredClone(source.rows.find(row => row.sourceRow === 871)), structuredClone(source.rows.find(row => row.sourceRow === 905))];
  const plan = planImport(input, catalog);
  assert.equal(plan.ready.length, 2);
  assert.deepEqual(plan.ready.map(row => row.idConfig), [8, 9]);
  assert.equal(plan.summary.mappedSourceRows, 2);
  assert.ok(plan.ready.every(row => row.appliesToAllConfigs === false));
  assert.deepEqual(planImport(input, catalog, { includePendingConfigs: true }), plan);
});

test('duplicate source rows for one selection are all quarantined', () => {
  const { catalog, input } = fixture();
  input.rows.push({ ...input.rows[0], sourceRow: 2000, uFactor: '9' });
  const plan = planImport(input, catalog);
  assert.equal(plan.ready.length, 0);
  assert.equal(plan.rejected.length, 2);
  assert.ok(plan.rejected.every(row => row.reason === 'DUPLICATE_SELECTION_KEY'));
});

test('apply is idempotent, rejects active conflicts before inserts and never edits old records', async () => {
  const { catalog, input } = fixture();
  const plan = planImport(input, catalog);
  const stored = [];
  const db = { energyRating: { findMany: async () => stored, create: async ({ data }) => stored.push({ ...data }) } };
  assert.deepEqual(await applyPlan(db, plan), { inserted: 1, unchanged: 0, previouslyInactive: 0 });
  assert.deepEqual(await applyPlan(db, plan), { inserted: 0, unchanged: 1, previouslyInactive: 0 });
  const conflicting = structuredClone(plan);
  conflicting.ready[0].uFactor = '2.000000';
  await assert.rejects(applyPlan(db, conflicting), /Active energy rating conflict/);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].uFactor, '1.075000');
  stored[0].isActive = false;
  stored[0].activeKey = null;
  assert.deepEqual(await applyPlan(db, plan), { inserted: 0, unchanged: 0, previouslyInactive: 1 });
  await assert.rejects(applyPlan(db, conflicting), /Inactive energy rating conflict/);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].isActive, false);
});

test('apply discards source fields and legacy units and identifies the same rating across different input files', async () => {
  const { catalog, input } = fixture();
  const plan = planImport(input, catalog);
  Object.assign(plan.ready[0], { sourceFile: 'old.xlsx', sourceSheet: 'NFRC', sourceRow: 92, sourceVersion: '0.9', sourceGlassId: 'GL-1', composition: 'input only', notes: 'input only', units: 'legacy unit' });
  const stored = [];
  const db = { energyRating: { findMany: async () => stored, create: async ({ data }) => stored.push({ ...data }) } };
  await applyPlan(db, plan);
  for (const field of ['sourceFile', 'sourceSheet', 'sourceRow', 'sourceVersion', 'sourceGlassId', 'composition', 'notes', 'units']) {
    assert.equal(Object.hasOwn(stored[0], field), false);
  }
  const otherInput = structuredClone(input);
  otherInput.sourceFile = 'renamed.xlsx';
  otherInput.sourceVersion = '1.0';
  otherInput.rows[0].sourceRow = 2000;
  assert.deepEqual(await applyPlan(db, planImport(otherInput, catalog)), { inserted: 0, unchanged: 1, previouslyInactive: 0 });
});

test('import defaults to dry run and rejects contradictory or stale-catalog apply', () => {
  assert.equal(argumentsFor([]).apply, false);
  assert.equal(argumentsFor([]).includePendingConfigs, undefined);
  assert.equal(argumentsFor(['--include-pending-configs', '--dry-run']).includePendingConfigs, true);
  assert.throws(() => argumentsFor(['--apply', '--dry-run']), /either/);
  assert.throws(() => argumentsFor(['--apply', '--catalog', 'catalog.json']), /live catalog/);
});

test('preflight rejects later conflicts before any insert and rejects malformed active keys', async () => {
  const { catalog, input } = fixture();
  const plan = planImport(input, catalog);
  const existing = { ...plan.ready[0], id: 1, uFactor: '2.000000' };
  const added = { ...plan.ready[0], idTint: 50, activeKey: '2:2:50:2:1:1' };
  let inserts = 0;
  const db = { energyRating: { findMany: async () => [existing], create: async () => { inserts += 1; } } };
  await assert.rejects(applyPlan(db, { ready: [added, ...plan.ready] }), /Active energy rating conflict/);
  assert.equal(inserts, 0);
  existing.activeKey = null;
  await assert.rejects(applyPlan(db, plan), /inconsistent selection key/);
  assert.equal(inserts, 0);
});
