'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { validateBackup } = require('./pricing-range-backup-check.cjs');

const base = path.resolve(__dirname, '../.tmp');
fs.mkdirSync(base, { recursive: true });
const folder = fs.mkdtempSync(path.join(base, 'pricing-backup-test-'));
let sequence = 0;
after(() => fs.rmdirSync(folder));
const rule = { id: 17, idBrand: 1, idProduct: 3, idSystem: 8, idConfig: 12, idCrystal: 4, costoA: '1.12345678901234567890', costoB: '2', costoC: '-3.25' };
const keys = Object.keys(rule);
function dump({ columns = keys, row = rule, database = 'impact', complete = true, explicit = false, table = 'pricing_rules' } = {}) {
  return `-- Host: localhost    Database: ${database}\nCREATE TABLE \`${table}\` (\n${columns.map(c => `  \`${c}\` decimal(24,20),`).join('\n')}\n) ENGINE=InnoDB;\nINSERT INTO \`${table}\`${explicit ? ' (`id`)' : ''} VALUES (${columns.map(c => row[c]).join(',')});\n${complete ? '-- Dump completed on 2026-10-10\n' : ''}`;
}
async function fixture(sql, run, truncated = false) {
  const file = path.join(folder, `backup-${sequence++}.sql.gz`);
  const bytes = gzipSync(sql);
  fs.writeFileSync(file, truncated ? bytes.subarray(0, bytes.length - 6) : bytes);
  try { return await run(file); } finally { fs.unlinkSync(file); }
}
test('matches exact coefficients and associations with reordered columns and table case', async () => {
  await fixture(dump({ columns: [...keys].reverse(), table: 'PRICING_RULES' }), async file => {
    assert.equal((await validateBackup(file, [rule], 'impact')).verifiedDirectRules, 1);
  });
});
test('rejects a stale coefficient differing at the twentieth decimal', async () => {
  await fixture(dump({ row: { ...rule, costoA: '1.12345678901234567891' } }), file => assert.rejects(validateBackup(file, [rule], 'impact'), /does not match/));
});
test('rejects a rule reassigned to another crystal', async () => {
  await fixture(dump({ row: { ...rule, idCrystal: 9 } }), file => assert.rejects(validateBackup(file, [rule], 'impact'), /does not match/));
});
test('rejects a missing affected rule', async () => {
  await fixture(dump({ row: { ...rule, id: 18 } }), file => assert.rejects(validateBackup(file, [rule], 'impact'), /missing/));
});
test('rejects a dump of another database', async () => {
  await fixture(dump({ database: 'other' }), file => assert.rejects(validateBackup(file, [rule], 'impact'), /expected database/));
});
test('rejects an incomplete dump', async () => {
  await fixture(dump({ complete: false }), file => assert.rejects(validateBackup(file, [rule], 'impact'), /complete dump/));
});
test('rejects unsupported explicit column syntax', async () => {
  await fixture(dump({ explicit: true }), file => assert.rejects(validateBackup(file, [rule], 'impact'), /Unsupported/));
});
test('rejects a corrupt gzip even if SQL data was readable', async () => {
  await fixture(dump(), file => assert.rejects(validateBackup(file, [rule], 'impact'), /integrity/), true);
});
