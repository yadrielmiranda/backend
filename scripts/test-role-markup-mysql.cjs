// Exercises the migration and real role API against a disposable local MySQL database.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.chdir(path.resolve(__dirname, '..'));
const configured = process.env.DATABASE_URL || require('dotenv').parse(fs.readFileSync('.env')).DATABASE_URL;
const url = new URL(configured);
assert.equal(url.protocol, 'mysql:');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Local MySQL required');
const database = 'impact_role_markup_check_' + randomUUID().replaceAll('-', '');
const mysql = process.env.MYSQL_BIN || (process.platform === 'win32'
  ? 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe' : 'mysql');
function sql(statement, inTestDatabase = true) {
  return execFileSync(mysql, [
    '--protocol=tcp', '--host=127.0.0.1', '--port=' + (url.port || '3306'),
    '--batch', '--skip-column-names', '--user=' + decodeURIComponent(url.username),
    ...(inTestDatabase ? [database] : []),
  ], {
    input: statement, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) },
  }).toString().trim();
}

const precisionMigration = '20261109180000_role_markup_precision';
const columnPrecision = () => sql("SELECT NUMERIC_PRECISION, NUMERIC_SCALE FROM information_schema.COLUMNS " +
  "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='Role' AND COLUMN_NAME='markup'");
function migrateFixture() {
  const migrations = fs.readdirSync('prisma/migrations', { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert(migrations.includes(precisionMigration), 'Role precision migration must exist');
  const apply = names => sql(names.map(name =>
    fs.readFileSync(path.join('prisma/migrations', name, 'migration.sql'), 'utf8')).join('\n'));
  apply(migrations.filter(name => name < precisionMigration));
  assert.equal(columnPrecision(), '10\t4');
  sql("INSERT INTO Role (name,markup,updatedAt) VALUES " +
    "('fixture-client',0.755125,NOW(3)),('fixture-negative',-999999.9999,NOW(3))," +
    "('fixture-zero',0,NOW(3)),('fixture-positive',999999.9999,NOW(3))");
  assert.equal(sql("SELECT markup FROM Role WHERE name='fixture-client'"), '0.7551',
    'Reproduce the old four-decimal rounding before applying the fix');
  apply(migrations.filter(name => name >= precisionMigration));
  assert.equal(columnPrecision(), '24\t18');
}

let created = false, db, app;
async function main() {
  sql('CREATE DATABASE ' + database + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', false);
  created = true;
  migrateFixture();
  url.pathname = '/' + database;
  process.env.DATABASE_URL = url.toString();
  require('ts-node/register/transpile-only');
  require('tsconfig-paths/register');
  const { Prisma } = require('@prisma/client');
  const { PrismaService } = require('../src/prisma/prisma.service');
  const { RolesController } = require('../src/roles/roles.controller');
  const { RolesService } = require('../src/roles/roles.service');
  const { LogsService } = require('../src/logs/logs.service');
  const { RolesGuard } = require('../src/auth/guards/roles/roles.guard');
  const { ValidationPipe } = require('@nestjs/common');
  const { Reflector } = require('@nestjs/core');
  const { Test } = require('@nestjs/testing');
  db = new PrismaService();

  for (const [name, expected] of [
    ['fixture-client', '0.7551'], ['fixture-negative', '-999999.9999'],
    ['fixture-zero', '0'], ['fixture-positive', '999999.9999'],
  ]) {
    const role = await db.role.findUniqueOrThrow({ where: { name } });
    assert.equal(role.markup.toFixed(), expected, 'Migration must preserve existing role values');
  }
  const client = await db.role.findUniqueOrThrow({ where: { name: 'fixture-client' } });
  const admin = await db.role.upsert({ where: { name: 'admin' }, update: {}, create: { name: 'admin' } });
  const actor = await db.user.create({ data: {
    username: 'role-markup-fixture', firstName: 'Fixture', lastName: 'Admin', idRole: admin.id, password: 'unused',
  } });
  const plan = await db.paymentPlan.create({ data: { name: 'Fixture payment plan', definition: {} } });
  const profile = await db.installationPriceProfile.create({ data: { name: 'Fixture installation profile' } });
  const module = await Test.createTestingModule({
    controllers: [RolesController], providers: [RolesService, LogsService, { provide: PrismaService, useValue: db }],
  }).compile();
  app = module.createNestApplication();
  app.use((req, _res, next) => { req.user = { id: actor.id, role: { name: req.get('test-role') } }; next(); });
  app.useGlobalGuards(new RolesGuard(module.get(Reflector)));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.init();
  const http = require('supertest')(app.getHttpServer());
  const rolePath = '/roles/' + client.id;
  const patch = payload => http.patch(rolePath).set('test-role', 'admin').send(payload);
  const exact = (actual, expected) => {
    assert.equal(typeof actual, 'string', 'The API must return decimal strings without a JS number conversion');
    assert.equal(new Prisma.Decimal(actual).toFixed(), expected);
  };
  async function verifyStored(expected) {
    const stored = await db.role.findUniqueOrThrow({ where: { id: client.id } });
    assert.equal(stored.markup.toFixed(), expected);
    const { body: reopened } = await http.get('/roles').set('test-role', 'admin').expect(200);
    exact(reopened.find(role => role.id === client.id).markup, expected);
  }

  for (const value of ['0.755125', '0.755125123456789012', '-0.000000123456789012',
    '999999.999999999999999999', '-999999.999999999999999999']) {
    const { body } = await patch({ markup: value }).expect(200);
    exact(body.markup, value);
    await verifyStored(value);
  }

  const precise = '0.755125123456789012';
  await patch({ markup: precise }).expect(200);
  for (const payload of [
    { paymentPlanId: plan.id }, { installationPriceProfileId: profile.id },
    { paymentPlanId: null }, { installationPriceProfileId: null },
  ]) {
    const { body } = await patch(payload).expect(200);
    exact(body.markup, precise);
    for (const [key, value] of Object.entries(payload)) assert.equal(body[key], value);
    await verifyStored(precise);
  }
  const lastAudit = await db.tempLog.findFirst({
    where: { event: { entityType: 'Role', entityId: client.id } }, orderBy: { id: 'desc' },
  });
  assert(lastAudit, 'Real update service must write its audit record');
  exact(lastAudit.after.markup, precise);
  assert(!lastAudit.meta.changedFields.includes('markup'), 'Partial edits must not report a markup change');

  for (const value of [null, '', '0.7551251234567890123', '1000000', '-1000000', true, {}, []]) {
    await patch({ markup: value }).expect(400);
    await verifyStored(precise);
  }
  for (const role of ['dealer', 'operator']) {
    await http.patch(rolePath).set('test-role', role).send({ markup: '0.1' }).expect(403);
  }
  for (const [value, expected] of [[0.15, '0.15'], [1e-7, '0.0000001'], [-0.25, '-0.25'], [0, '0']]) {
    const { body } = await patch({ markup: value }).expect(200);
    exact(body.markup, expected);
    await verifyStored(expected);
  }
  console.log('PASS: Role migration preserves old values; real API saves/reopens exact signed 18-decimal markup, protects partial edits, and supports legacy numbers.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  try {
    try { if (app) await app.close(); }
    finally { if (db) await db.$disconnect(); }
  } finally {
    if (created) sql('DROP DATABASE ' + database, false);
  }
});
