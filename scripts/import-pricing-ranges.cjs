'use strict';

// Standalone import: never bootstrap Nest or its notification/payment workers.
// Run from backend, with DATABASE_URL set for the intended environment:
// 1. Extract the unchanged workbook using extract-pricing-ranges.py.
// 2. Deploy the reviewed four-decimal migration before generating the final plan.
// 3. --input DATA.json --report PLAN.json (read-only; inspect errors and counts).
// 4. Create a fresh full MySQL backup, and pause pricing edits during import.
// 5. Add --apply --plan PLAN.json --target HOST:PORT/DB --backup FULL.sql.gz,
//    using a NEW --report filename. Remote connections also need --allow-remote.
// --rollback-test replaces --apply for a local transaction rollback rehearsal;
// rolled-back inserts can advance MySQL auto-increment counters.
// Reports and the .before.json snapshot contain the exact affected rules.
// Keep these and the full backup private; do not commit them to the repository.
// If completion is uncertain, run another read-only plan before retrying.
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { connection, loadCatalog } = require('./pricing-range-catalog.cjs');
const { buildPlan, hash, rangeData, ruleData, canonicalRange, rangeKey } = require('./pricing-range-import-core.cjs');
const { validateBackup } = require('./pricing-range-backup-check.cjs');

function boundPlan(input, catalog, target) {
  const plan = buildPlan(input, catalog);
  delete plan.planHash;
  plan.database = target;
  plan.inputHash = hash(input);
  plan.planHash = hash(plan);
  return plan;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function writeExclusive(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

async function mutate(tx, plan) {
  const ids = plan.directRulesToRemove.map(rule => rule.id);
  if (ids.length) {
    const removed = await tx.pricingRule.deleteMany({ where: { id: { in: ids } } });
    if (removed.count !== ids.length) throw new Error('Deleted rule count differs from reviewed plan.');
  }
  const created = [];
  for (const range of plan.rangesToCreate) {
    const saved = await tx.pricingRange.create({ data: { ...rangeData(range), rules: { create: range.rules.map(ruleData) } }, include: { rules: true } });
    if (JSON.stringify(canonicalRange(saved)) !== JSON.stringify(canonicalRange(range))) throw new Error(`Precision or rule mismatch after saving ${rangeKey(range)}.`);
    created.push({ id: saved.id, key: rangeKey(saved), crystalRules: saved.rules.length });
  }
  return created;
}

// A workbook-specific planner must run in every snapshot, including the
// Serializable pre-write snapshot and the post-write verification snapshot.
async function run(args, { planner = boundPlan } = {}) {
  const allowed = new Set(['--input', '--report', '--apply', '--plan', '--target', '--backup', '--allow-remote', '--rollback-test']);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!allowed.has(name) || options[name] !== undefined) throw new Error(`Unknown or duplicate option: ${name}`);
    if (['--apply', '--allow-remote', '--rollback-test'].includes(name)) options[name] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
      options[name] = args[++i];
    }
  }
  if (!options['--input'] || !options['--report']) throw new Error('Usage: node scripts/import-pricing-ranges.cjs --input DATA.json --report PLAN.json [--apply|--rollback-test --plan REVIEWED.json --target HOST:PORT/DB --backup FULL.sql.gz]');
  if (options['--apply'] && options['--rollback-test']) throw new Error('Choose apply or rollback-test, not both.');
  const output = path.resolve(options['--report']);
  if (fs.existsSync(output)) throw new Error('Report already exists; choose a new file.');
  const { value, target } = connection();
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.host);
  if (!local && !options['--allow-remote']) throw new Error('Remote database access requires --allow-remote and separate authorization.');
  if (options['--rollback-test'] && !local) throw new Error('Rollback testing is limited to a local database.');
  const writing = options['--apply'] || options['--rollback-test'];
  if (writing && options['--target'] !== `${target.host}:${target.port}/${target.database}`) throw new Error('Exact --target confirmation is required.');
  if (writing && (!options['--plan'] || !options['--backup'])) throw new Error('A reviewed plan and full backup are required before changes.');
  const input = readJson(options['--input']);
  const db = new PrismaClient({ datasources: { db: { url: value } } });
  let committed = false;
  try {
    if (!writing) {
      const plan = await db.$transaction(async tx => planner(input, await loadCatalog(tx), target, tx), { isolationLevel: 'RepeatableRead', timeout: 120000 });
      writeExclusive(output, plan);
      console.log(JSON.stringify({ mode: 'dry-run', ...plan.summary, needsPrecisionMigration: plan.needsPrecisionMigration, planHash: plan.planHash, report: output }));
      if (plan.errors.length) process.exitCode = 2;
      return;
    }
    const reviewed = readJson(options['--plan']);
    const { planHash, ...hashedPart } = reviewed;
    if (hash(hashedPart) !== planHash) throw new Error('Reviewed plan hash is invalid.');
    if (reviewed.errors.length || reviewed.needsPrecisionMigration) throw new Error('Reviewed plan has blockers or still needs the four-decimal migration.');
    const backup = await validateBackup(options['--backup'], reviewed.directRulesToRemove, target.database);
    const snapshotFile = output + '.before.json';
    writeExclusive(snapshotFile, { operation: 'pricing-range-import', database: target, source: reviewed.source, planHash, backup, directRules: reviewed.directRulesToRemove });
    const baseline = hash(await loadCatalog(db));
    let result, rolledBack = false;
    const rollback = new Error('Intentional local rollback verification');
    try {
      await db.$transaction(async tx => {
        const catalog = await loadCatalog(tx);
        const fresh = await planner(input, catalog, target, tx);
        if (fresh.planHash !== planHash) throw new Error('Catalog or input changed after review; generate and review a new dry-run.');
        if (fresh.errors.length || fresh.needsPrecisionMigration) throw new Error('Validation failed inside the transaction.');
        const created = await mutate(tx, fresh);
        const after = await loadCatalog(tx);
        const removedIds = new Set(fresh.directRulesToRemove.map(r => r.id));
        if (hash(after.directRules) !== hash(catalog.directRules.filter(r => !removedIds.has(r.id)))) throw new Error('Unrelated direct rules changed.');
        const existingIds = new Set(catalog.ranges.map(r => r.id));
        if (hash(after.ranges.filter(r => existingIds.has(r.id))) !== hash(catalog.ranges)) throw new Error('Existing ranges changed.');
        for (const key of Object.keys(catalog).filter(key => !['ranges', 'directRules'].includes(key))) {
          if (hash(after[key]) !== hash(catalog[key])) throw new Error(`Unrelated catalog data changed: ${key}.`);
        }
        const recheck = await planner(input, after, target, tx);
        if (recheck.errors.length || recheck.summary.createRanges !== 0 || recheck.summary.removeDirectRules !== 0 || recheck.summary.unchangedRanges !== fresh.summary.ranges) throw new Error('Post-import validation failed.');
        result = { status: options['--rollback-test'] ? 'rollback_verified' : 'applied', database: target, source: fresh.source, planHash, backup, beforeSnapshot: snapshotFile, deletedDirectRuleIds: [...removedIds], createdRanges: created, summary: { ...fresh.summary, directRulesAfter: after.directRules.length, rangesAfter: after.ranges.length, crystalRulesAfter: after.ranges.reduce((n, r) => n + r.rules.length, 0) } };
        if (options['--rollback-test']) throw rollback;
      }, { isolationLevel: 'Serializable', timeout: 180000, maxWait: 10000 });
      committed = true;
    } catch (error) {
      if (error !== rollback) throw error;
      rolledBack = true;
    }
    if (rolledBack && hash(await loadCatalog(db)) !== baseline) throw new Error('Rollback verification failed: catalog data differs.');
    writeExclusive(output, result);
    console.log(JSON.stringify({ status: result.status, ...result.summary, report: output, beforeSnapshot: snapshotFile }));
  } catch (error) {
    error.importCommitted = committed;
    throw error;
  } finally {
    await db.$disconnect();
  }
}

module.exports = { run, boundPlan, mutate };
if (require.main === module) run(process.argv.slice(2)).catch(error => {
  // Avoid printing database connection strings or provider query payloads.
  if (error.importCommitted) console.error('The import committed, but the final report could not be saved. Run a read-only dry-run to verify the current state.');
  else console.error(error.code ? `Import did not finish verification (${error.code}). Run a read-only dry-run to determine the current state.` : error.message);
  process.exitCode = 1;
});
