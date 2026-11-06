// Exercise the HTTP upload limits against real MySQL locks and private files.
// Only synthetic data is used, in a new local database and a temporary directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
process.chdir(root);
const configured = process.env.DATABASE_URL || require('dotenv').parse(fs.readFileSync('.env')).DATABASE_URL;
const url = new URL(configured);
assert.equal(url.protocol, 'mysql:');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Local MySQL required');
const dbName = 'impact_note_check_' + randomUUID().replaceAll('-', '');
const mysql = process.env.MYSQL_BIN || (process.platform === 'win32'
  ? 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe' : 'mysql');
function sql(statement, inTestDatabase = true) {
  execFileSync(mysql, [
    '--protocol=tcp', '--host=127.0.0.1', '--port=' + (url.port || '3306'),
    '--user=' + decodeURIComponent(url.username), ...(inTestDatabase ? [dbName] : []),
  ], {
    input: statement, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) },
  });
}

let created = false;
let directory;
let db;
let app;
async function main() {
  sql('CREATE DATABASE ' + dbName + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', false);
  created = true;
  const migrations = fs.readdirSync('prisma/migrations', { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  sql(migrations.map(name => fs.readFileSync(path.join('prisma/migrations', name, 'migration.sql'), 'utf8')).join('\n'));
  url.pathname = '/' + dbName;
  process.env.DATABASE_URL = url.toString();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-note-check-'));
  process.env.NOTE_ATTACHMENTS_DIR = directory;
  require('ts-node/register/transpile-only');
  require('tsconfig-paths/register');
  const { Test } = require('@nestjs/testing');
  const { UnauthorizedException } = require('@nestjs/common');
  const { PrismaService } = require('../src/prisma/prisma.service');
  const { JwtAuthGuard } = require('../src/auth/guards/auth/auth.guard');
  const { EstimateNoteAttachmentsController, EstimateNoteUploadGuard } = require('../src/estimates/estimate-note-attachments.controller');
  const { EstimateNoteAttachmentsService } = require('../src/estimates/estimate-note-attachments.service');
  const { NotificationsService } = require('../src/notifications/notifications.service');
  db = new PrismaService();
  const people = {};
  for (const roleName of ['admin', 'operator', 'dealer', 'client']) {
    const role = await db.role.create({ data: { name: roleName } });
    const user = await db.user.create({ data: {
      username: roleName, firstName: 'Test', lastName: roleName, idRole: role.id, password: 'unused',
    } });
    people[roleName] = { id: user.id, role: { name: roleName } };
  }
  const status = await db.estimateStatus.create({ data: { name: 'Test draft' } });
  async function estimate(number, owner = people.dealer) {
    return db.estimate.create({ data: {
      number, name: 'Attachment test', units: 0, rateT: 0, priceT: 0, netProfit: 0,
      statusId: status.id, idUser: owner.id,
    } });
  }
  const first = await estimate('Count');
  const second = await estimate('Size');
  const other = await estimate('Other owner', people.admin);
  const module = await Test.createTestingModule({
    controllers: [EstimateNoteAttachmentsController],
    providers: [EstimateNoteAttachmentsService, EstimateNoteUploadGuard, { provide: PrismaService, useValue: db },
      { provide: NotificationsService, useValue: new NotificationsService(db) }],
  }).overrideGuard(JwtAuthGuard).useValue({ canActivate(context) {
    const req = context.switchToHttp().getRequest();
    req.user = people[req.get('test-actor')];
    if (!req.user) throw new UnauthorizedException();
    return true;
  } }).compile();
  app = module.createNestApplication();
  await app.init();
  const http = require('supertest')(app.getHttpServer());
  const endpoint = est => '/estimates/' + est.id + '/internal-note/attachments';
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage();
  const pdf = Buffer.from(await doc.save());
  function paddedPdf(bytes) {
    const pos = pdf.lastIndexOf('%%EOF');
    return Buffer.concat([pdf.subarray(0, pos), Buffer.alloc(bytes - pdf.length, 0x20), pdf.subarray(pos)]);
  }
  function upload(est, bytes = pdf, role = 'dealer') {
    return http.post(endpoint(est)).set('test-actor', role).attach('file', bytes, 'opening.pdf');
  }
  for (let i = 0; i < 4; i++) await upload(first).expect(201);
  const results = await Promise.all([upload(first), upload(first)]);
  for (const result of results) assert(result.status < 500, JSON.stringify(result.body));
  assert.equal(results.filter(result => result.status === 201).length, 1, 'only one upload gets the fifth slot');
  const list = await http.get(endpoint(first)).set('test-actor', 'dealer').expect(200);
  assert.equal(list.body.attachments.length, 5);
  assert.equal(list.body.usedBytes, 5 * pdf.length);
  assert.equal(list.body.storage, null);
  const id = list.body.attachments[0].id;
  const item = endpoint(first) + '/' + id;
  await http.get(item).expect(401);
  await http.get(item).set('test-actor', 'client').expect(403);
  await http.get(endpoint(other)).set('test-actor', 'dealer').expect(404);
  await http.get(endpoint(second) + '/' + id).set('test-actor', 'admin').expect(404);
  const viewed = await http.get(item).set('test-actor', 'operator').expect(200);
  assert.deepEqual(viewed.body, pdf);
  await http.delete(item).set('test-actor', 'operator').expect(403);
  await http.delete(item).set('test-actor', 'dealer').expect(200);
  await http.get(item).set('test-actor', 'operator').expect(404);
  await upload(first).expect(201);
  assert.equal(await db.estimateInternalNote.count(), 0, 'files work without a text note');
  console.log('PASS count limit under contention, private reads, ownership, deletion and re-upload');

  const large = paddedPdf(10_000_000);
  await upload(second, large).expect(201);
  await upload(second, large).expect(201);
  const over = await upload(second, paddedPdf(5_000_001));
  assert(over.status >= 400 && over.status < 500);
  const full = await upload(second, paddedPdf(5_000_000)).expect(201);
  assert.equal(full.body.usedBytes, 25_000_000);
  console.log('PASS exactly 10 MB per file and 25 MB per estimate, rejecting one byte over');

  // Simulate previously stored files to exercise GB boundaries without allocating gigabytes.
  const quota = db.estimateNoteAttachmentQuota;
  // Older deployments can have a warning recorded at their former 5 GB cap.
  await quota.update({ where: { id: 1 }, data: { usedBytes: 5_000_000_000n, warned: true } });
  const aboveOldCap = await upload(other, pdf, 'admin').expect(201);
  assert.deepEqual(aboveOldCap.body.storage, { usedBytes: 5_000_000_000 + pdf.length, warning: false });
  assert.equal(await db.notification.count(), 0);
  await quota.update({ where: { id: 1 }, data: { usedBytes: BigInt(9_000_000_000 - pdf.length) } });
  const warning = await upload(other, pdf, 'admin').expect(201);
  assert.equal(warning.body.storage.usedBytes, 9_000_000_000);
  assert.equal(warning.body.storage.warning, true);
  assert.equal(await db.notification.count({ where: { recipientId: people.admin.id } }), 1);
  const adminNotice = await db.notification.findFirstOrThrow({ where: { recipientId: people.admin.id } });
  assert.match(adminNotice.message, /9 GB.*10 GB/);
  await quota.update({ where: { id: 1 }, data: { usedBytes: BigInt(10_000_000_000 - pdf.length + 1) } });
  await upload(other, pdf, 'admin').expect(409);
  await quota.update({ where: { id: 1 }, data: { usedBytes: BigInt(10_000_000_000 - pdf.length) } });
  const contenders = await Promise.all([upload(other, pdf, 'admin'), upload(other, pdf, 'admin')]);
  assert.deepEqual(contenders.map(result => result.status).sort(), [201, 409]);
  assert.equal((await quota.findUniqueOrThrow({ where: { id: 1 } })).usedBytes, 10_000_000_000n);
  assert.equal(await db.notification.count(), 1);
  console.log('PASS upgrade from the old quota, single 9 GB admin notification and concurrent 10 GB hard limit');

  const filesBeforeDelete = (await http.get(endpoint(second)).set('test-actor', 'admin').expect(200)).body.attachments;
  await db.estimate.delete({ where: { id: second.id } });
  await module.get(EstimateNoteAttachmentsService).reclaimUnusedFiles();
  for (const file of filesBeforeDelete) assert(!fs.existsSync(path.join(directory, file.id)));
  assert.equal((await quota.findUniqueOrThrow({ where: { id: 1 } })).usedBytes, 9_975_000_000n);
  console.log('PASS deleting an estimate reclaims its private files and disk quota');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  try { await app?.close(); await db?.$disconnect(); }
  finally {
    if (created) sql('DROP DATABASE ' + dbName, false);
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});
