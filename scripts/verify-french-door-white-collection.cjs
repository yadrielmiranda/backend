/* Run only against the disposable MySQL instance prepared for this task.
 * This script verifies its data directory before creating any test schemas.
 * It never reads .env, connects to impact, or changes the installed MySQL service.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.resolve(root, '../outputs/french-door-27-validation');
const mysql = 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
const expectedDirectory = path.join(output, 'mysql/data');
const migrationPath = path.join(root, 'prisma/migrations/20261123120000_add_french_door_white_collection/migration.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const originalMigration = fs.readFileSync(path.join(root, 'prisma/migrations/20261106200000_french_door_designs/migration.sql'), 'utf8');
const createTable = originalMigration.slice(0, originalMigration.indexOf(';') + 1);
const normalize = value => value.trim().replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function sql(text, database, allowFailure = false) {
  const args = ['--no-defaults', '--protocol=TCP', '--host=127.0.0.1', '--port=13367', '--user=root', '--batch', '--raw', '--skip-column-names'];
  if (database) args.push('--database=' + database);
  const result = spawnSync(mysql, args, { input: text, encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(result.stderr || 'MySQL command failed');
  return { status: result.status, stdout: result.stdout.replace(/\r\n/g, '\n').trim(), stderr: result.stderr.trim() };
}
const identity = sql('SELECT @@datadir, @@port, @@version;').stdout.split('\t');
assert.equal(normalize(identity[0]), normalize(fs.realpathSync(expectedDirectory)), 'Refusing unexpected MySQL datadir');
assert.equal(identity[1], '13367', 'Refusing unexpected MySQL port');
const suffix = new Date().toISOString().replace(/\D/g, '');
const expected = [];
for (let n = 97; n <= 110; n++) expected.push(['SD' + n, 'AE-SD-' + n, 'SINGLE']);
for (let n = 97; n <= 109; n++) expected.push(['DD' + n, 'AE-DD-' + n, 'DOUBLE']);
const fixtures = [];
for (const prefix of ['SD', 'DD']) for (let n = 1; n <= 96; n++) {
  const index = fixtures.length;
  fixtures.push([1001 + index, prefix + String(n).padStart(2, '0'), n === 1 ? 'CUSTOM-' + prefix + '-KEEP' : 'AE-' + prefix + '-' + String(n).padStart(2, '0'), prefix === 'SD' ? 'SINGLE' : 'DOUBLE', index % 7 === 0 ? null : ((1200 + index) / 100).toFixed(2)]);
}
function quoted(value) { return value === null ? 'NULL' : typeof value === 'number' ? value : "'" + value + "'"; }
function prepare(scenario, extraSql = '') {
  const database = 'fd27_test_' + suffix + '_' + scenario;
  sql('CREATE DATABASE ' + database + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;');
  const inserts = fixtures.map(row => '(' + row.map(quoted).join(',') + ')').join(',\n');
  sql(createTable + '\nINSERT INTO french_door_designs (id, artworkKey, code, kind, unitPrice) VALUES ' + inserts + ';\n' + extraSql, database);
  return database;
}
function rows(database) {
  return sql('SELECT id, artworkKey, code, kind, IFNULL(CAST(unitPrice AS CHAR), "NULL") FROM french_door_designs ORDER BY id;', database).stdout;
}
const report = { verifiedInstance: { dataDirectory: identity[0], port: Number(identity[1]), version: identity[2] }, migrationSha256: hash(migration), tests: [] };
const baseline = prepare('baseline');
const before = rows(baseline);
sql(migration, baseline);
const after = rows(baseline);
const lines = after.split('\n');
assert.equal(lines.length, 219);
assert.equal(lines.slice(0, 192).join('\n'), before, 'Original fixture IDs, artwork, custom codes and prices must be unchanged');
const added = lines.slice(192).map(line => line.split('\t'));
assert.equal(added.length, 27);
for (const [key, code, kind] of expected) {
  const row = added.find(row => row[1] === key);
  assert.ok(row, 'Missing ' + key);
  assert.deepEqual(row.slice(1), [key, code, kind, 'NULL']);
}
const pricedBefore = fixtures.filter(row => row[4] !== null).length;
assert.equal(Number(sql('SELECT COUNT(*) FROM french_door_designs WHERE unitPrice IS NOT NULL;', baseline).stdout), pricedBefore);
sql(migration, baseline);
assert.equal(rows(baseline), after, 'Reapplying must preserve all row values and IDs');
report.tests.push({ name: 'additive migration and idempotence', database: baseline, previousRows: 192, resultingRows: 219, added: 27, previousRowsSha256: hash(before), preservedRowsSha256: hash(lines.slice(0, 192).join('\n')), newPrices: null, pricedRowsBeforeAndAfter: pricedBefore, passed: true });
const collisions = [
  ['code_collision', "UPDATE french_door_designs SET code='AE-SD-100' WHERE artworkKey='SD02';"],
  ['key_collision', "INSERT INTO french_door_designs (artworkKey,code,kind,unitPrice) VALUES ('SD100','CUSTOM-OCCUPIED','SINGLE',42.42);"],
  ['kind_collision', "INSERT INTO french_door_designs (artworkKey,code,kind,unitPrice) VALUES ('DD100','AE-DD-100','SINGLE',NULL);"],
  ['case_collision', "INSERT INTO french_door_designs (artworkKey,code,kind,unitPrice) VALUES ('sd100','AE-SD-100','SINGLE',NULL);"],
];
for (const [name, setup] of collisions) {
  const database = prepare(name, setup);
  const snapshot = rows(database);
  const result = sql(migration, database, true);
  assert.notEqual(result.status, 0, name + ' must fail rather than skip or overwrite');
  assert.match(result.stderr, /ERROR 1062/, name + ' should reject unique-key collision');
  assert.equal(rows(database), snapshot, name + ' must leave no partial insert or modified record');
  report.tests.push({ name, database, passed: true, error: 'MySQL ERROR 1062', preservedRowsSha256: hash(snapshot) });
}
async function verifySelection() {
  require('ts-node/register/transpile-only');
  const { PrismaClient } = require('@prisma/client');
  const { resolveDoorDesign } = require('../src/door-designs/piece-door-design');
  const { DOOR_DESIGN_PICKER } = require('../src/door-designs/door-design-policy');
  const database = prepare('selection');
  sql(migration, database);
  const db = new PrismaClient({ datasourceUrl: 'mysql://root@127.0.0.1:13367/' + database });
  try {
    const persisted = await db.frenchDoorDesign.findMany({ where: { artworkKey: { in: expected.map(row => row[0]) } } });
    assert.equal(persisted.length, 27);
    const available = await db.frenchDoorDesign.findMany(DOOR_DESIGN_PICKER);
    assert.equal(available.some(row => persisted.some(added => added.id === row.id)), false);
    for (const design of persisted) {
      const context = { dimensionMode: 'STANDARD', isSelectableInEstimate: true,
        system: { allowDesign: true, isActive: true, idBrand: 2, idProduct: 5, brandProduct: { product: { diagramFamily: 'FRENCH_DOOR', kind: 'GLAZED_UNIT' } } },
        config: { isActive: true, idProduct: 5, conf: design.kind === 'SINGLE' ? 'X' : 'XX' } };
      // Product/series context is a fixture; the catalog read/write uses the real isolated MySQL instance.
      const selectionDb = { frenchDoorDesign: db.frenchDoorDesign, sysConf: { findUnique: async () => context } };
      const input = { idProd: 5, idBrand: 2, idSyst: 10, idConf: 4, idDoorDesign: design.id };
      await assert.rejects(resolveDoorDesign(selectionDb, input), /unavailable/);
      // A synthetic fixture price is set only in this throwaway schema to exercise quoted selection.
      await db.frenchDoorDesign.update({ where: { id: design.id }, data: { unitPrice: '123.45' } });
      const resolved = await resolveDoorDesign(selectionDb, input);
      assert.equal(resolved.idDoorDesign, design.id);
      assert.equal(resolved.doorDesignSnapshot.artworkKey, design.artworkKey);
      assert.equal(resolved.doorDesignSnapshot.code, design.code);
      assert.equal(resolved.doorDesignSnapshot.kind, design.kind);
      assert.equal(resolved.doorDesignSnapshot.unitPrice, '123.45');
    }
    const priced = await db.frenchDoorDesign.findMany(DOOR_DESIGN_PICKER);
    assert.equal(priced.filter(row => persisted.some(added => added.id === row.id)).length, 27);
    report.tests.push({ name: 'persisted catalog selection and snapshots', database, rows: 27, nullPriceRejectedForEveryRow: true,
      fixturePriceOnly: '123.45', realMySqlCatalog: true, productAndSeriesContext: 'fixture', passed: true });
  } finally { await db.$disconnect(); }
}
verifySelection().then(() => {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'backend-migration-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}).catch(error => { console.error(error); process.exitCode = 1; });
