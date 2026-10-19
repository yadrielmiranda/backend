'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { planImport, activeKey } = require('./energy-ratings-import-core.cjs');
const { loadEnergyCatalog } = require('./energy-ratings-catalog.cjs');
const { applyPlan, sameRating } = require('./import-energy-ratings.cjs');

// Only the 80 original rows blocked by the corrected 3/16 -> 5/16 label.
const SOURCE_REF = '8835fc0b231f54901184bc83ec3b0833baba208b:data/energy-ratings-nfrc-v0.9.json';
const SOURCE_ROWS = [10, 31, 52, 473, 508].flatMap(start => Array.from({ length: 16 }, (_, index) => start + index));
const serialize = rows => JSON.stringify(rows);

function readSource() {
  return JSON.parse(execFileSync('git', ['-C', path.resolve(__dirname, '..'), 'show', SOURCE_REF], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function planBatch(source, catalog) {
  const selectedRows = source.rows.filter(row => SOURCE_ROWS.includes(row.sourceRow));
  assert.deepEqual(selectedRows.map(row => row.sourceRow).sort((a, b) => a - b), SOURCE_ROWS, 'The original 80 source rows must all be present exactly once.');
  const options = { includePendingConfigs: true };
  const fullPlan = planImport(source, catalog, options);
  const batch = planImport({ ...source, rows: selectedRows }, catalog, options);
  assert.deepEqual(batch.rejected, [], 'Some of the 80 rows still fail catalog validation.');
  assert.equal(batch.ready.length, 80, 'Expected exactly 80 energy ratings in this batch.');
  assert.equal(new Set(batch.ready.map(row => row.activeKey)).size, 80);
  const fullByKey = new Map(fullPlan.ready.map(row => [row.activeKey, row]));
  for (const row of batch.ready) {
    // Keep full-source duplicate and physical-variant checks even for this small batch.
    assert.deepEqual(fullByKey.get(row.activeKey), row, 'A selected row conflicts with another row in the original source.');
  }
  return batch;
}

async function processBatch(tx, source, apply) {
  const catalog = await loadEnergyCatalog(tx);
  const batch = planBatch(source, catalog);
  const before = await tx.energyRating.findMany({ orderBy: { id: 'asc' } });
  for (const row of before) {
    assert.ok(!row.isActive || row.activeKey === activeKey(row), `Existing rating ${row.id} has an inconsistent selection key.`);
  }
  let unchanged = 0;
  for (const row of batch.ready) {
    const matches = before.filter(existing => activeKey(existing) === row.activeKey);
    if (!matches.length) continue;
    const active = matches.filter(existing => existing.isActive);
    assert.equal(active.length, 1, `Review existing inactive or duplicate ratings for ${row.activeKey}.`);
    assert.ok(sameRating(active[0], row), `Existing energy values differ for ${row.activeKey}; nothing will be overwritten.`);
    unchanged += 1;
  }
  const toInsert = batch.ready.length - unchanged;
  const bySeries = [...new Set(batch.ready.map(row => row.idSystem))].map(idSystem => ({
    series: catalog.systems.find(system => system.id === idSystem).name,
    records: batch.ready.filter(row => row.idSystem === idSystem).length,
  }));
  const report = { sourceRows: SOURCE_ROWS.length, readyRecords: batch.ready.length, existingRecords: before.length, toInsert, unchanged, expectedTotal: before.length + toInsert, bySeries };
  if (!apply) return report;

  const result = await applyPlan(tx, batch);
  assert.deepEqual(result, { inserted: toInsert, unchanged, previouslyInactive: 0 });
  const after = await tx.energyRating.findMany({ orderBy: { id: 'asc' } });
  const beforeIds = new Set(before.map(row => row.id));
  assert.equal(serialize(after.filter(row => beforeIds.has(row.id))), serialize(before), 'Existing energy ratings must remain unchanged.');
  assert.equal(after.length, before.length + toInsert);
  const expectedByKey = new Map(batch.ready.map(row => [row.activeKey, row]));
  for (const row of after.filter(row => !beforeIds.has(row.id))) {
    assert.ok(expectedByKey.has(row.activeKey), 'An inserted row is outside the approved batch.');
    assert.ok(sameRating(row, expectedByKey.get(row.activeKey)));
  }
  return { ...report, ...result, existingRecordsPreserved: before.length, totalRecords: after.length };
}

function parseArgs(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (['--target-host', '--target-database'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown option ${arg}`);
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('Choose either --apply or --dry-run.');
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const source = readSource();
  const { PrismaClient } = require('@prisma/client');
  const { connection } = require('./pricing-range-catalog.cjs');
  const { value, target } = connection();
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.host), 'Run this script on the database host.');
  if (options.apply) {
    assert.equal(options['target-host'], target.host, '--target-host must match the connected host.');
    assert.equal(options['target-database'], target.database, '--target-database must match the connected database.');
  }
  const db = new PrismaClient({ datasources: { db: { url: value } } });
  try {
    const result = await db.$transaction(tx => processBatch(tx, source, options.apply), {
      isolationLevel: options.apply ? 'Serializable' : 'RepeatableRead', timeout: 120000,
    });
    console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', target, ...result }, null, 2));
  } finally { await db.$disconnect(); }
}

module.exports = { readSource, planBatch, processBatch, parseArgs };

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  // Never expose a connection URL or driver error containing credentials.
  console.error(error.code || (error.name === 'PrismaClientInitializationError' ? 'Database unavailable. Verify the local database service.' : error.message));
  process.exitCode = 1;
});
