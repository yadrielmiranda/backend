// Static only: Node built-ins; no .env, database clients, SQL engines or process execution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const migrationName = '20261123180000_add_french_door_eco_white_collection';
const migration = fs.readFileSync(path.join(root, 'prisma/migrations', migrationName, 'migration.sql'), 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const singleSources = [2,3,4,9,28,36,37,38,40,42,53,54,55,56,59,60,62,65,66,71,72,75,76,77,79,80,81,82,83,84,85,86,91,95,99,100,102,105,108,109,110];
const doubleSources = [2,23,24,29,37,38,46,53,54,55,59,60,61,62,63,64,67,68,69,70,71,73,75,78,81];
const expected = [
  ...singleSources.map((source, index) => ({ artworkKey: 'SD' + (111 + index), code: 'AE-SD-' + (111 + index), kind: 'SINGLE', sourceCode: 'EWSWH' + String(source).padStart(3, '0') })),
  ...doubleSources.map((source, index) => ({ artworkKey: 'DD' + (110 + index), code: 'AE-DD-' + (110 + index), kind: 'DOUBLE', sourceCode: 'EWDWH' + String(source).padStart(3, '0') })),
];
assert.equal(singleSources.length, 41);
assert.equal(doubleSources.length, 25);
const sql = migration.replace(/^\s*--.*$/gm, '').trim();
const statements = sql.split(';').map(value => value.trim()).filter(Boolean);
assert.equal(statements.length, 3, 'Only transaction, one additive insert and commit are permitted');
assert.equal(statements[0], 'START TRANSACTION');
assert.equal(statements[2], 'COMMIT');
const insert = statements[1];
assert.doesNotMatch(insert, /\b(?:UPDATE|DELETE|REPLACE|IGNORE|ALTER|DROP|TRUNCATE|CALL|EXECUTE)\b/i);
const envelope = /^INSERT INTO `french_door_designs` \(`artworkKey`, `code`, `kind`, `unitPrice`\)\s+SELECT catalog\.`artworkKey`, catalog\.`code`, catalog\.`kind`, NULL\s+FROM \(([\s\S]+)\) AS catalog\s+WHERE NOT EXISTS \(\s*SELECT 1 FROM `french_door_designs` AS existing\s+WHERE BINARY existing\.`artworkKey` = BINARY catalog\.`artworkKey`\s+AND BINARY existing\.`code` = BINARY catalog\.`code`\s+AND existing\.`kind` = catalog\.`kind`\s*\)$/;
const match = envelope.exec(insert);
assert.ok(match, 'SQL must insert generated IDs/NULL prices and skip only exact key/code/kind mappings');
const clauses = match[1].trim().split(/\s+UNION ALL\s+/);
const parsed = clauses.map((clause, index) => {
  const row = /^SELECT '(SD\d+|DD\d+)'(?: AS `artworkKey`)?, '(AE-(?:SD|DD)-\d+)'(?: AS `code`)?, '(SINGLE|DOUBLE)'(?: AS `kind`)?$/.exec(clause.trim());
  assert.ok(row, 'Unexpected SQL in catalog row ' + index);
  return { artworkKey: row[1], code: row[2], kind: row[3] };
});
assert.deepEqual(parsed, expected.map(({ artworkKey, code, kind }) => ({ artworkKey, code, kind })));
assert.equal(new Set(parsed.map(row => row.artworkKey)).size, 66);
assert.equal(new Set(parsed.map(row => row.code)).size, 66);
const provenance = [...migration.matchAll(/^\s*-- (AE-(?:SD|DD)-\d+) <- (EW[SD]WH\d{3})$/gm)].map(match => [match[1], match[2]]);
assert.deepEqual(provenance, expected.map(row => [row.code, row.sourceCode]));
const previousMigrations = ['20261106200000_french_door_designs', '20261108120000_complete_french_door_design_catalog', '20261123120000_add_french_door_white_collection'];
const previousKeys = new Set();
const previousCodes = new Set();
const previousMigrationHashes = {};
for (const name of previousMigrations) {
  const contents = fs.readFileSync(path.join(root, 'prisma/migrations', name, 'migration.sql'), 'utf8');
  previousMigrationHashes[name] = hash(contents);
  const previousSql = contents.replace(/^\s*--.*$/gm, '');
  for (const match of previousSql.matchAll(/'(SD\d+|DD\d+)'/g)) previousKeys.add(match[1]);
  for (const match of previousSql.matchAll(/'(AE-(?:SD|DD)-\d+)'/g)) previousCodes.add(match[1]);
}
assert.equal(previousKeys.size, 219, 'Expected 219 existing repository artwork keys');
assert.equal(previousCodes.size, 219, 'Expected 219 existing repository commercial codes');
for (const row of parsed) {
  assert.equal(previousKeys.has(row.artworkKey), false, 'Existing artwork key must never be reused: ' + row.artworkKey);
  assert.equal(previousCodes.has(row.code), false, 'Existing code must never be reused: ' + row.code);
}
const policy = fs.readFileSync(path.join(root, 'src/door-designs/door-design-policy.ts'), 'utf8');
const resolver = fs.readFileSync(path.join(root, 'src/door-designs/piece-door-design.ts'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
assert.match(policy, /where:\s*\{\s*unitPrice:\s*\{\s*not:\s*null\s*\}\s*\}/);
assert.match(resolver, /design\?\.unitPrice == null/);
assert.match(schema, /artworkKey\s+String\s+@unique/);
assert.match(schema, /code\s+String\s+@unique/);
let manifestCompared = false;
if (process.argv[2]) {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
  assert.deepEqual(manifest.entries.map(({ artworkKey, code, kind, sourceCode }) => ({ artworkKey, code, kind, sourceCode })), expected);
  manifestCompared = true;
}
console.log(JSON.stringify({
  status: 'passed (static only)', databaseAccessed: false, migrationExecuted: false,
  migration: migrationName, migrationSha256: hash(migration), rows: 66, singleRows: 41, doubleRows: 25,
  previousRepositoryKeys: previousKeys.size, previousRepositoryCodes: previousCodes.size,
  expectedTotalAfterFutureApplication: 285, repositoryCodeAndKeyCollisions: 0,
  insertOnly: true, generatedIds: true, nullPrices: true, exactMappingIdempotencyGuard: true,
  uniqueConstraintsPreserved: true, priceEligibilityPreserved: true, sourceMappingsVerified: 66, manifestCompared,
  previousMigrationHashes, codes: parsed.map(row => row.code),
  pending: ['Database contents and collisions were not queried.', 'SQL was not executed; runtime/application verification remains pending.'],
}, null, 2));
