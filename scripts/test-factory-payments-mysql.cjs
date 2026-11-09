// Real HTTP and InnoDB checks using only a disposable LOCAL database.
// Never reads or changes application rows from the configured database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

process.chdir(path.resolve(__dirname, '..'));
const configured = process.env.DATABASE_URL || require('dotenv').parse(fs.readFileSync('.env')).DATABASE_URL;
const url = new URL(configured);
assert.equal(url.protocol, 'mysql:');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Local MySQL required');
const database = 'impact_factory_payment_check_' + randomUUID().replaceAll('-', '');
assert(/^impact_factory_payment_check_[a-f0-9]{32}$/.test(database));
const mysql = process.env.MYSQL_BIN || (process.platform === 'win32'
  ? 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe' : 'mysql');
function sql(statement, useDatabase = true) {
  return execFileSync(mysql, ['--protocol=tcp', '--host=127.0.0.1', '--port=' + (url.port || 3306),
    '--user=' + decodeURIComponent(url.username), ...(useDatabase ? [database] : [])], {
    input: statement, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) },
  });
}

let created = false, db, app;
async function main() {
  sql('CREATE DATABASE ' + database + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', false);
  created = true;
  const migrations = fs.readdirSync('prisma/migrations', { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  sql(migrations.map(name => fs.readFileSync(path.join('prisma/migrations', name, 'migration.sql'), 'utf8')).join('\n'));
  url.pathname = '/' + database;
  process.env.DATABASE_URL = url.toString();
  require('ts-node/register/transpile-only');
  require('tsconfig-paths/register');
  const { Test } = require('@nestjs/testing');
  const { ValidationPipe, UnauthorizedException } = require('@nestjs/common');
  const { PrismaService } = require('../src/prisma/prisma.service');
  const { JwtAuthGuard } = require('../src/auth/guards/auth/auth.guard');
  const { FactoryPaymentsModule } = require('../src/factory-payments/factory-payments.module');
  const { ResponsePrivacyInterceptor } = require('../src/common/response-privacy.interceptor');
  db = new PrismaService();
  const people = {};
  for (const name of ['admin', 'operator', 'dealer', 'client', 'technician']) {
    const role = await db.role.upsert({ where: { name }, create: { name }, update: {} });
    const user = await db.user.create({ data: {
      username: name, firstName: 'Fixture', lastName: name, idRole: role.id, password: 'unused',
    } });
    people[name] = { id: user.id, role: { name } };
  }
  const estimateStatus = await db.estimateStatus.upsert({ where: { name: 'Active' }, create: { name: 'Active' }, update: {} });
  const orderStatus = await db.orderStatus.upsert({ where: { name: 'In process' }, create: { name: 'In process' }, update: {} });
  const brand = await db.brand.create({ data: { name: 'Fixture' } });
  const product = await db.product.create({ data: { name: 'Fixture' } });
  await db.brandProduct.create({ data: { idBrand: brand.id, idProduct: product.id } });
  const system = await db.system.create({ data: { name: 'Fixture', idBrand: brand.id, idProduct: product.id } });
  const config = await db.config.create({ data: { conf: 'X', idProduct: product.id } });
  const frame = await db.frameColor.create({ data: { color: 'White' } });
  async function order(number, poNumber, rateReal, imported = false) {
    const estimate = await db.estimate.create({ data: {
      number, name: 'Project ' + number, units: 1, rateT: '100.00', priceT: '200.00', netProfit: '100.00',
      totalPayable: '214.00', statusId: estimateStatus.id, idUser: people.client.id,
    } });
    const payment = await db.payment.create({ data: {
      idEst: estimate.id, userId: people.client.id, status: 'PAID', amount: '214.00',
    } });
    const result = await db.order.create({ data: {
      number, units: 1, amount: '214.00', price: '200.00', saleSubtotal: '200.00', rate: '100.00', netProfit: '100.00',
      idEst: estimate.id, statusId: orderStatus.id, userId: people.client.id, paymentId: payment.id,
      poNumber, rateReal, netProfitReal: rateReal == null ? null : '42.00',
    } });
    if (poNumber) await db.factoryPo.create({ data: { poNumber, orderId: result.id } });
    if (imported) {
      const piece = await db.piece.create({ data: {
        idEst: estimate.id, mark: '1', idProd: product.id, idBrand: brand.id, idSyst: system.id,
        idConf: config.id, idFC: frame.id, qty: 1, rate: '100', price: '200', subtotal: '200',
        netProfit: '100', customerPrice: '200', customerSubtotal: '200', netProfitD: '0',
      } });
      await db.factoryUnit.create({ data: { lineNumber: poNumber + '01', pieceId: piece.id } });
    }
    return result;
  }
  const pending = await order('PENDING', null, null);
  const manual = await order('MANUAL', '990002', '50.00');
  const imported = await order('IMPORTED', '990003', '1162.63500000', true);
  const second = await order('SECOND', '990004', '100.00', true);
  await db.factoryPo.create({ data: {
    poNumber: 'EXTERNAL-ONLY', orderName: 'Must never be listed',
    externalUnits: { create: { lineNumber: 'EXTERNAL-ONLY01', description: 'Warehouse only' } },
  } });
  const snapshot = async () => JSON.stringify(await Promise.all([
    db.order.findMany({ orderBy: { id: 'asc' } }), db.estimate.findMany({ orderBy: { id: 'asc' } }),
    db.payment.findMany({ orderBy: { id: 'asc' } }), db.piece.findMany({ orderBy: { id: 'asc' } }),
    db.factoryPo.findMany({ orderBy: { id: 'asc' } }), db.factoryUnit.findMany({ orderBy: { lineNumber: 'asc' } }),
  ]));
  let original = await snapshot();
  const module = await Test.createTestingModule({ imports: [FactoryPaymentsModule] })
    .overrideProvider(PrismaService).useValue(db)
    .overrideGuard(JwtAuthGuard).useValue({ canActivate(context) {
      const req = context.switchToHttp().getRequest();
      req.user = people[req.get('test-actor')];
      if (!req.user) throw new UnauthorizedException();
      return true;
    } }).compile();
  app = module.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true,
    transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalInterceptors(new ResponsePrivacyInterceptor());
  await app.init();
  const http = require('supertest')(app.getHttpServer());
  const base = '/factory-payments';
  const get = (route, actor = 'admin') => http.get(base + route).set('test-actor', actor);
  const post = (route, body, actor = 'admin') => http.post(base + route).set('test-actor', actor).send(body);
  const put = (route, body) => http.put(base + route).set('test-actor', 'admin').send(body);
  const patch = (route, body) => http.patch(base + route).set('test-actor', 'admin').send(body);
  const route = order => '/orders/' + order.id;
  const manufacturer = (await get('/manufacturers').expect(200)).body[0];
  assert.equal(manufacturer.name, 'Eco Window Systems');
  assert.equal(manufacturer.isDefault, true);
  const charge = (changes = {}) => ({
    manufacturerId: manufacturer.id, amount: '100.00', paidOn: '2026-11-09', invoiceNumber: '990003-D',
    kind: 'DEPOSIT', reference: '02249G', note: 'Fixture amount only', requestId: randomUUID(), ...changes,
  });

  await http.get(base + '/orders').expect(401);
  for (const actor of ['operator', 'dealer', 'client', 'technician']) {
    await get('/orders', actor).expect(403);
    await get(route(imported), actor).expect(403);
    await get('/manufacturers', actor).expect(403);
    await post(route(imported) + '/payments', charge(), actor).expect(403);
    await post('/manufacturers', { name: 'Not permitted' }, actor).expect(403);
  }
  const initial = (await get('/orders').expect(200)).body;
  assert.equal(initial.total, 4, 'Only system orders, never external warehouse POs');
  assert.equal(initial.rows.find(row => row.orderId === imported.id).factoryTotal, '1162.64');
  assert.equal(initial.rows.find(row => row.orderId === pending.id).factoryTotal, null);
  assert.equal((await get('/orders?status=PENDING_IMPORT').expect(200)).body.total, 2);
  for (const unimported of [pending, manual]) {
    const response = await post(route(unimported) + '/payments', charge());
    assert([400, 409].includes(response.status), JSON.stringify(response.body));
    const assignment = await put(route(unimported) + '/account', { manufacturerId: manufacturer.id });
    assert([400, 409].includes(assignment.status));
  }
  assert.equal(await db.factoryPayment.count(), 0);
  assert.equal(await db.factoryPaymentAccount.count(), 0);
  console.log('PASS actual role guards, system-order scope, import proof and exact imported-cost rounding');

  for (const override of [{ amount: '0' }, { amount: '-1' }, { amount: '1.001' }, { amount: '1e2' },
    { amount: '10000000000' }, { paidOn: '2026-02-30' }, { paidOn: '0000-01-01' }, { invoiceNumber: '   ' }]) {
    await post(route(imported) + '/payments', charge(override)).expect(400);
  }
  const first = charge({ amount: '1110.84' });
  const concurrent = await Promise.all([post(route(imported) + '/payments', first), post(route(imported) + '/payments', first)]);
  assert(concurrent.every(r => r.status === 201), concurrent.map(r => JSON.stringify(r.body)).join('\n'));
  assert.equal(await db.factoryPayment.count(), 1, 'A repeated request must record one payment');
  let detail = (await get(route(imported)).expect(200)).body;
  assert.equal(detail.order.paid, '1110.84');
  assert.equal(detail.order.remaining, '51.80');
  assert.equal(detail.order.status, 'PARTIAL');
  await post(route(imported) + '/payments', { ...first, amount: '1110.85' }).expect(409);
  const final = charge({ amount: '51.80', version: detail.order.version, kind: 'FINAL', invoiceNumber: first.invoiceNumber });
  detail = (await post(route(imported) + '/payments', final).expect(201)).body;
  assert.equal(detail.payments.length, 2, 'The same invoice can legitimately contain multiple charges');
  assert.equal(detail.order.remaining, '0.00');
  assert.equal(detail.order.status, 'PAID');
  const extra = charge({ amount: '5.50', version: detail.order.version, invoiceNumber: '990003-FP' });
  detail = (await post(route(imported) + '/payments', extra).expect(201)).body;
  assert.equal(detail.order.remaining, '-5.50');
  assert.equal(detail.order.status, 'CREDIT');
  const overpaymentId = detail.payments.find(p => p.requestId === extra.requestId).id;
  await post('/payments/' + overpaymentId + '/void', { reason: '' }).expect(400);
  detail = (await post('/payments/' + overpaymentId + '/void', { reason: 'Incorrect duplicate charge' }).expect(201)).body;
  assert.equal(detail.order.status, 'PAID');
  assert(detail.payments.find(p => p.id === overpaymentId).voidedAt);
  const eventsAfterVoid = detail.events.length;
  const retryVoid = (await post('/payments/' + overpaymentId + '/void', { reason: 'Incorrect duplicate charge' }).expect(201)).body;
  assert.equal(retryVoid.events.length, eventsAfterVoid);
  assert.equal((await get('/orders?status=PAID').expect(200)).body.total, 1);
  assert.equal(await snapshot(), original, 'Tracking payments must not mutate any operational source row');
  console.log('PASS payment idempotency under contention, repeated invoice, credit, void history and zero operational changes');

  await db.order.update({ where: { id: imported.id }, data: { rateReal: '1200.00' } }); // Simulates a later JSON reimport, in this disposable DB only.
  original = await snapshot();
  detail = (await get(route(imported)).expect(200)).body;
  assert.equal(detail.order.sourceCostChanged, true);
  assert.equal(detail.order.factoryTotal, '1162.64');
  assert.equal(detail.order.importedTotal, '1200.00');
  await post(route(imported) + '/payments', charge({ version: detail.order.version })).expect(409);
  await post(route(imported) + '/sync-total', { version: detail.order.version - 1 }).expect(409);
  detail = (await post(route(imported) + '/sync-total', { version: detail.order.version }).expect(201)).body;
  assert.equal(detail.order.factoryTotal, '1200.00');
  assert.equal(detail.order.paid, '1162.64');
  assert.equal(detail.order.remaining, '37.36');
  assert.equal(detail.order.sourceCostChanged, false);
  assert(detail.events.some(event => event.action === 'TOTAL_SYNCED'));
  assert.equal(await snapshot(), original);

  const alternate = (await post('/manufacturers', { name: 'Second manufacturer', isDefault: true }).expect(201)).body;
  assert.equal((await get('/manufacturers').expect(200)).body.filter(m => m.isDefault).length, 1);
  await patch('/manufacturers/' + alternate.id, { active: false }).expect(400);
  await patch('/manufacturers/' + manufacturer.id, { active: false }).expect(200);
  await post(route(second) + '/payments', charge()).expect(400);
  detail = (await put(route(imported) + '/account', { manufacturerId: alternate.id, version: detail.order.version }).expect(200)).body;
  assert.equal(detail.order.manufacturer.id, alternate.id);
  assert.equal(detail.order.paid, '1162.64');
  const filtered = (await get('/orders?manufacturerId=' + alternate.id).expect(200)).body;
  assert.equal(filtered.total, 1);
  assert.equal(filtered.summary.paid, '1162.64');
  assert.equal(filtered.summary.remaining, '37.36');
  assert.equal((await get('/orders?search=990003&pageSize=1').expect(200)).body.total, 1);
  assert.equal((await get('/orders?search=EXTERNAL-ONLY').expect(200)).body.total, 0);
  assert.equal(await snapshot(), original);
  console.log('PASS reviewed cost sync, manufacturer catalog/defaults/filtering, external PO exclusion and preserved source values');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    try { if (app) await app.close(); }
    finally { if (db) await db.$disconnect(); }
  } finally {
    if (created) sql('DROP DATABASE ' + database, false);
  }
});
