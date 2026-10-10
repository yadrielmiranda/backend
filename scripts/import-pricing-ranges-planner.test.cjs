'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const core = require('./pricing-range-import-core.cjs');

// Exercise the real import orchestration with an in-memory transactional DB.
// A planner is asynchronous because V026 also validates the live NOA policy.
function harness({ changedProof = false, failPostProof = false } = {}) {
  const target = { host: 'localhost', port: '3306', database: 'impact' };
  const input = { workbook: 'synthetic orchestration fixture' };
  const createdRange = { idSystem: 8, idConfig: 10, code: 'NEW', minWidthIn: null, maxWidthIn: '67.0625', minHeightIn: null, maxHeightIn: null,
    minWidthInclusive: true, maxWidthInclusive: true, minHeightInclusive: true, maxHeightInclusive: true, sortOrder: 0, isActive: true,
    rules: [{ idCrystal: 7, costoA: '2', costoB: '3', costoC: '4' }] };
  const directRule = { id: 99, idSystem: 8, idConfig: 10, idCrystal: 7, costoA: '2', costoB: '3', costoC: '4' };
  const original = { directRules: [directRule], ranges: [{ ...structuredClone(createdRange), id: 17, idSystem: 900, code: 'PRESERVED' }], catalogMarker: ['unchanged'] };
  const files = new Map();
  const logs = [];
  const plannerCalls = [];
  let mutations = 0;
  const db = { catalog: structuredClone(original), disconnected: false,
    async $disconnect() { this.disconnected = true; },
    async $transaction(callback) {
      const tx = { catalog: structuredClone(this.catalog), transactionMarker: true };
      tx.pricingRule = { deleteMany: async ({ where }) => {
        const oldCount = tx.catalog.directRules.length;
        tx.catalog.directRules = tx.catalog.directRules.filter(rule => !where.id.in.includes(rule.id));
        mutations++;
        return { count: oldCount - tx.catalog.directRules.length };
      } };
      tx.pricingRange = { create: async ({ data }) => {
        const saved = { ...data, id: 21, rules: data.rules.create };
        tx.catalog.ranges.push(saved);
        mutations++;
        return saved;
      } };
      const result = await callback(tx);
      this.catalog = tx.catalog;
      return result;
    },
  };
  function planned(catalog, proof = 'same-policy') {
    const applied = catalog.ranges.some(range => range.id === 21);
    const plan = { source: { name: 'test workbook' }, database: target, inputHash: core.hash(input), catalogHash: core.hash(catalog),
      noaCoverageProof: proof, errors: [], warnings: [], needsPrecisionMigration: false,
      directRulesToRemove: applied ? [] : [directRule], rangesToCreate: applied ? [] : [createdRange],
      summary: { ranges: 1, crystalRules: 1, createRanges: applied ? 0 : 1, unchangedRanges: applied ? 1 : 0, removeDirectRules: applied ? 0 : 1 } };
    return { ...plan, planHash: core.hash(plan) };
  }
  files.set(path.resolve('input.json'), JSON.stringify(input));
  files.set(path.resolve('reviewed.json'), JSON.stringify(planned(original)));
  const mockFs = {
    existsSync: file => files.has(path.resolve(file)),
    readFileSync: file => {
      if (!files.has(path.resolve(file))) throw new Error(`Missing mock file ${file}`);
      return files.get(path.resolve(file));
    },
    writeFileSync: (file, content, options) => {
      const key = path.resolve(file);
      if (options.flag === 'wx' && files.has(key)) throw new Error('Mock output already exists');
      files.set(key, content);
    },
  };
  const mockRequire = name => {
    if (name === 'node:fs') return mockFs;
    if (name === 'node:path') return path;
    if (name === '@prisma/client') return { PrismaClient: class { constructor() { return db; } } };
    if (name === './pricing-range-catalog.cjs') return { connection: () => ({ value: 'in-memory-only', target }), loadCatalog: async client => structuredClone(client.catalog) };
    if (name === './pricing-range-import-core.cjs') return core;
    if (name === './pricing-range-backup-check.cjs') return { validateBackup: async () => ({ verified: true }) };
    throw new Error(`Unexpected mock dependency: ${name}`);
  };
  const module = { exports: {} };
  const context = { require: mockRequire, module, process: { exitCode: 0 }, console: { log: value => logs.push(value), error: value => logs.push(value) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'import-pricing-ranges.cjs'), 'utf8'), context);
  const planner = async (actualInput, catalog, actualTarget, tx) => {
    assert.equal(core.hash(actualInput), core.hash(input));
    assert.deepEqual(actualTarget, target);
    assert.equal(tx.transactionMarker, true);
    plannerCalls.push(catalog.ranges.length);
    await Promise.resolve();
    if (failPostProof && catalog.ranges.some(range => range.id === 21)) throw new Error('Live NOA proof failed after writing');
    return planned(catalog, changedProof ? 'changed-policy' : 'same-policy');
  };
  const run = writing => module.exports.run(['--input', 'input.json', '--report', 'result.json',
    ...(writing ? ['--apply', '--plan', 'reviewed.json', '--target', 'localhost:3306/impact', '--backup', 'backup.sql.gz'] : [])], { planner });
  return { db, original, files, logs, plannerCalls, run, get mutations() { return mutations; } };
}

test('read-only dry-run invokes the async workbook planner within its snapshot', async () => {
  const h = harness();
  await h.run(false);
  assert.deepEqual(h.plannerCalls, [1]);
  assert.equal(h.mutations, 0);
  assert.equal(JSON.parse(h.files.get(path.resolve('result.json'))).noaCoverageProof, 'same-policy');
  assert.equal(h.db.disconnected, true);
});

test('apply invokes the same async planner before and after writing and preserves unrelated data', async () => {
  const h = harness();
  await h.run(true);
  assert.deepEqual(h.plannerCalls, [1, 2]);
  assert.equal(h.mutations, 2);
  assert.equal(h.db.catalog.ranges.length, 2);
  assert.equal(core.hash(h.db.catalog.ranges[0]), core.hash(h.original.ranges[0]));
  assert.deepEqual(h.db.catalog.catalogMarker, h.original.catalogMarker);
  assert.equal(h.db.catalog.directRules.length, 0);
  assert.equal(JSON.parse(h.files.get(path.resolve('result.json'))).status, 'applied');
});

test('a changed proof after review blocks the import before any mutation', async () => {
  const h = harness({ changedProof: true });
  await assert.rejects(h.run(true), /Catalog or input changed after review/);
  assert.equal(h.mutations, 0);
  assert.equal(core.hash(h.db.catalog), core.hash(h.original));
  assert.equal(h.files.has(path.resolve('result.json')), false);
  assert.equal(h.db.disconnected, true);
});

test('failed post-write proof rolls the entire import back', async () => {
  const h = harness({ failPostProof: true });
  await assert.rejects(h.run(true), /Live NOA proof failed after writing/);
  assert.deepEqual(h.plannerCalls, [1, 2]);
  assert.equal(h.mutations, 2);
  assert.equal(core.hash(h.db.catalog), core.hash(h.original));
  assert.equal(h.files.has(path.resolve('result.json')), false);
  assert.equal(h.db.disconnected, true);
});
