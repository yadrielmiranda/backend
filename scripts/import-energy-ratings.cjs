'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { planImport, activeKey } = require('./energy-ratings-import-core.cjs');
const { loadEnergyCatalog } = require('./energy-ratings-catalog.cjs');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
const RATING_FIELDS = ['idSystem', 'idCrystal', 'idTint', 'idCoating', 'idPrivacy', 'idConfig', 'appliesToAllConfigs', 'uFactor', 'shgc', 'vlt', 'isActive', 'activeKey'];
function sameRating(left, right) {
  return activeKey(left) === activeKey(right) && left.appliesToAllConfigs === right.appliesToAllConfigs &&
    ['uFactor', 'shgc', 'vlt'].every(key => left[key] !== null && Number(left[key]) === Number(right[key]));
}

async function applyPlan(db, plan) {
  const existing = await db.energyRating.findMany();
  for (const row of existing) {
    if (row.isActive && row.activeKey !== activeKey(row)) throw new Error(`Existing active energy rating ${row.id} has an inconsistent selection key. Review it before importing.`);
  }
  const active = new Map(existing.filter(row => row.isActive).map(row => [row.activeKey, row]));
  const bySelection = new Map();
  for (const row of existing) {
    const key = activeKey(row);
    if (!bySelection.has(key)) bySelection.set(key, []);
    bySelection.get(key).push(row);
  }
  const insert = [];
  let unchanged = 0;
  let previouslyInactive = 0;
  // Validate the full plan before the first insert. Never overwrite another version.
  for (const row of plan.ready) {
    const present = active.get(row.activeKey);
    if (present) {
      if (!sameRating(present, row)) throw new Error(`Active energy rating conflict for ${row.activeKey}. Review this existing version before importing.`);
      unchanged += 1;
    } else if (bySelection.has(row.activeKey)) {
      const historic = bySelection.get(row.activeKey);
      if (!historic.some(record => sameRating(record, row))) throw new Error(`Inactive energy rating conflict for ${row.activeKey}. Review this combination before importing.`);
      previouslyInactive += 1;
    } else insert.push(row);
  }
  for (const row of insert) {
    const data = Object.fromEntries(RATING_FIELDS.map(field => [field, row[field]]));
    await db.energyRating.create({ data });
  }
  return { inserted: insert.length, unchanged, previouslyInactive };
}

function argumentsFor(argv) {
  const options = { source: path.resolve(__dirname, '../data/energy-ratings-nfrc-v0.9.json'), apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (['--source', '--catalog', '--verified-scope', '--output', '--target-host', '--target-database'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown option ${arg}`);
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('Choose either --apply or --dry-run.');
  if (options.apply && options.catalog) throw new Error('--apply always validates the live catalog; --catalog is for dry-run only.');
  return options;
}

function writeReport(output, report) {
  if (!output) return;
  const directory = path.resolve(output);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, value] of [['energy-summary.json', report.summary], ['energy-ready.json', report.ready], ['energy-rejected.json', report.rejected]]) {
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n');
  }
  const headers = ['sourceRow', 'productLabel', 'sourceGlassId', 'glassDescription', 'composition', 'reason'];
  const csv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  fs.writeFileSync(path.join(directory, 'energy-rejected.csv'), '\uFEFF' + [headers.map(csv).join(','), ...report.rejected.map(row => headers.map(key => csv(row[key])).join(','))].join('\r\n') + '\r\n');
}

async function main(argv) {
  const options = argumentsFor(argv);
  const source = readJson(options.source);
  const mappingOptions = { configScopes: options['verified-scope'] ? readJson(options['verified-scope']) : {} };
  let report;
  let result;
  let target = null;
  if (options.catalog) {
    const snapshot = readJson(options.catalog);
    report = planImport(source, snapshot.catalog || snapshot, mappingOptions);
  } else {
    const { PrismaClient } = require('@prisma/client');
    const { connection } = require('./pricing-range-catalog.cjs');
    const connectionInfo = connection();
    target = connectionInfo.target;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.host)) throw new Error('This importer only connects to a local database. Deploy the reviewed source and run locally on the destination host.');
    if (options.apply && (options['target-host'] !== target.host || options['target-database'] !== target.database)) throw new Error('--apply requires --target-host and --target-database matching the live target.');
    const db = new PrismaClient({ datasources: { db: { url: connectionInfo.value } } });
    try {
      await db.$transaction(async tx => {
        const catalog = await loadEnergyCatalog(tx);
        report = planImport(source, catalog, mappingOptions);
        if (options.apply) result = await applyPlan(tx, report);
      }, { isolationLevel: options.apply ? 'Serializable' : 'RepeatableRead', timeout: 120000 });
    } finally { await db.$disconnect(); }
  }
  writeReport(options.output, report);
  console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', target, ...report.summary, ...(result || {}), ...(options.output ? { output: path.resolve(options.output) } : {}) }, null, 2));
}

module.exports = { applyPlan, argumentsFor, sameRating };

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  // Connection errors may contain credentials in arbitrary driver messages.
  console.error(error.code || (error.name === 'PrismaClientInitializationError' ? 'Database unavailable. Verify the local database service and DATABASE_URL.' : error.message));
  process.exitCode = 1;
});
