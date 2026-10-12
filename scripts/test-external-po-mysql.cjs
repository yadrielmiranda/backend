// Integration check against a disposable local MySQL database. Never imports user files.
// Run from backend: node scripts/test-external-po-mysql.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
process.chdir(root);
const envLine = fs.readFileSync(path.join(root, '.env'), 'utf8').match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
const configuredUrl = process.env.DATABASE_URL || envLine?.[1].trim().replace(/^['"]|['"]$/g, '');
if (!configuredUrl) throw new Error('A local DATABASE_URL is required.');
const url = new URL(configuredUrl);
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'This check only supports local MySQL.');
const database = `impact_external_po_check_${Date.now()}_${randomUUID().slice(0, 8)}`;
assert(/^impact_external_po_check_\d+_[a-f0-9]{8}$/.test(database));
const mysql = process.env.MYSQL_BIN || 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe';
const connectionArgs = ['--protocol=tcp', '--host=127.0.0.1', `--port=${url.port || 3306}`, `--user=${decodeURIComponent(url.username)}`, '--default-character-set=utf8mb4', '--batch'];
const runSql = (sql, selectDatabase = true) => execFileSync(mysql, [...connectionArgs, ...(selectDatabase ? [`--database=${database}`] : [])], {
  input: sql, encoding: 'utf8', env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let created = false;
let db;
async function main() {
  const migrationsDirectory = path.join(root, 'prisma/migrations');
  const targetMigration = '20261012120000_external_factory_pos';
  const baselineMigrations = fs.readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name < targetMigration).map(entry => entry.name).sort();
  assert(baselineMigrations.length > 0, 'The migration history is required.');
  const ddl = baselineMigrations.map(name => fs.readFileSync(path.join(migrationsDirectory, name, 'migration.sql'), 'utf8')).join('\n');
  runSql(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`, false);
  created = true;
  runSql(ddl);
  // Synthetic pre-migration rows exercise ownership backfill and preservation. These
  // fixtures deliberately omit the unrelated commercial graph in this disposable DB.
  runSql(`SET FOREIGN_KEY_CHECKS=0;
    INSERT INTO \`Order\` (id, number, units, amount, price, saleSubtotal, rate, netProfit, poNumber, idEst, statusId, userId, paymentId, updatedAt)
    VALUES (100, 'LEGACY-CHECK', 1, 0, 0, 0, 0, 0, '880001', 100, 100, 100, 100, CURRENT_TIMESTAMP(3));
    INSERT INTO Piece (id, idEst, mark, idProd, idBrand, idSyst, idConf, idFC, qty, rate, price, subtotal, netProfit, customerPrice, customerSubtotal, netProfitD, updatedAt)
    VALUES (100, 100, 'CHECK', 100, 100, 100, 100, 100, 1, 0, 0, 0, 0, 0, 0, 0, CURRENT_TIMESTAMP(3));
    INSERT INTO factory_units (lineNumber, pieceId) VALUES ('88000101', 100);
    INSERT INTO warehouse_stock (lineNumber, expectedParts, onHand, unassigned, updatedAt) VALUES ('88000101', 2, 1, 1, CURRENT_TIMESTAMP(3));
    INSERT INTO factory_pickup_runs (id, technicianId, status, activeSlot, updatedAt) VALUES (100, 100, 'PARTIAL', NULL, CURRENT_TIMESTAMP(3));
    INSERT INTO factory_pickup_run_orders (pickupRunId, orderId, activeSlot) VALUES (100, 100, NULL);
    SET FOREIGN_KEY_CHECKS=1;`);
  runSql(fs.readFileSync(path.join(root, 'prisma/migrations/20261012120000_external_factory_pos/migration.sql'), 'utf8'));
  console.log('PASS migration applied to existing schema with synthetic internal PO, unit, stock and pickup');

  url.pathname = `/${database}`;
  process.env.DATABASE_URL = url.toString();
  process.env.TS_NODE_PROJECT = path.join(root, 'tsconfig.json');
  require('ts-node/register/transpile-only');
  require('tsconfig-paths/register');
  const { PrismaClient } = require('@prisma/client');
  const { ExternalPoService } = require('../src/warehouse/external-po/external-po.service');
  const { WarehouseService } = require('../src/warehouse/warehouse.service');
  db = new PrismaClient({ datasourceUrl: url.toString() });
  const registry = await db.factoryPo.findUnique({ where: { poNumber: '880001' } });
  assert.equal(registry.orderId, 100);
  assert.equal((await db.factoryUnit.findUnique({ where: { lineNumber: '88000101' } })).pieceId, 100);
  assert.equal((await db.warehouseStock.findUnique({ where: { lineNumber: '88000101' } })).onHand, 1);
  assert.equal((await db.factoryPickupRunOrder.findUnique({ where: { pickupRunId_orderId: { pickupRunId: 100, orderId: 100 } } })).externalPoId, null);
  await assert.rejects(() => db.factoryUnit.create({ data: { lineNumber: '88000102' } }), /check constraint/i);
  console.log('PASS internal ownership/balances/membership preserved and source constraint enforced');

  const adminRole = await db.role.upsert({ where: { name: 'admin' }, create: { name: 'admin' }, update: {} });
  const techRole = await db.role.upsert({ where: { name: 'technician' }, create: { name: 'technician' }, update: {} });
  const adminUser = await db.user.create({ data: { username: 'external-check-admin', firstName: 'Check', lastName: 'Admin', password: 'not-a-login', idRole: adminRole.id } });
  const technician = await db.user.create({ data: { username: 'external-check-tech', firstName: 'Check', lastName: 'Technician', password: 'not-a-login', idRole: techRole.id } });
  const admin = { id: adminUser.id, role: { name: 'admin' } };
  const tech = { id: technician.id, role: { name: 'technician' } };
  const importer = new ExternalPoService(db);
  const warehouse = new WarehouseService(db);
  const storeA = await warehouse.createStore({ name: 'Check A' }, admin);
  const storeB = await warehouse.createStore({ name: 'Check B' }, admin);
  const document = (po, rows) => Buffer.from(JSON.stringify({
    schema: 'ews.purchase-order.ai-export.v3', po_number: po, order_name: 'Inventory check', supplier: { name: 'ECO' },
    total: 'ignored', discounted_total: 'ignored', currency: 'ignored', status: 'Delivered',
    lines: rows.map(([id, description, panels]) => ({ line_number: id, qty: 1, mark: '', description, product_details: { panels } })),
  }));
  const file = document('990001', [['99000101', 'Serie 600 French Door X Bronze\nPanels: 2', 2], ['99000102', 'Horizontal Rolling Window OX\nPanels: 1', 1]]);
  const secondFile = document('990002', [['99000201', 'Sliding Glass Door 700 XX\nPanels: 3', 3]]);
  const confirm = async (buffer) => {
    const preview = await importer.preview(buffer, admin);
    return importer.confirm(buffer, { revision: preview.revision, reviewed: 'true', parts: JSON.stringify(preview.lines.map(l => ({ lineNumber: l.lineNumber, expectedParts: l.expectedParts }))) }, admin);
  };
  const preview = await importer.preview(file, admin);
  assert.deepEqual(preview.lines.map(l => l.expectedParts), [3, 1]);
  await confirm(file);
  await confirm(secondFile);
  assert.equal((await confirm(file)).unchanged, true);
  const initial = await warehouse.unit('I99000101', admin);
  assert.equal(initial.expectedParts, 3);
  assert.equal(initial.source, 'EXTERNAL');
  assert.equal(initial.orderId, null);
  assert.equal(initial.onHand, 0);
  assert.equal(initial.inTransit, 0);
  assert.equal(await db.order.count(), 1);
  assert.equal(await db.payment.count(), 0);
  await assert.rejects(() => importer.preview(document('880001', [['99000999', 'French Door', 1]]), admin), /system order/i);
  await assert.rejects(() => importer.preview(document('990003', [['99000101', 'French Door', 1]]), admin), /another PO/i);
  console.log('PASS minimal import, numeric extra panel, no financial side effects, duplicates and idempotent reimport');

  const pickup = await warehouse.startFactoryPickup({ poNumbers: ['990001', '990002'], technicianIds: [tech.id] }, admin);
  assert.equal(pickup.poCount, 2);
  assert.equal(new Set(pickup.orders.map(o => o.key)).size, 2);
  for (let i = 0; i < 3; i++) await warehouse.factoryPickupScan(pickup.id, { barcode: 'I99000101', requestKey: randomUUID() }, tech);
  const transit = await warehouse.unit('99000101', admin);
  const receipt = { storeId: storeA.id, requestKey: randomUUID(), items: [{ barcode: 'I99000101', quantity: 3, version: transit.version }] };
  await warehouse.receive(receipt, admin);
  const release = await warehouse.scan({ barcode: 'I99000101', action: 'RELEASE', storeId: storeA.id, requestKey: randomUUID() }, admin);
  assert.equal(release.stock.onHand, 2);
  assert.equal(release.stock.released, 1);
  await warehouse.undo(release.movement.id, { requestKey: randomUUID() }, admin);
  const beforeTransfer = await warehouse.unit('99000101', admin);
  await warehouse.transfer({ barcode: '99000101', fromStoreId: storeA.id, toStoreId: storeB.id, quantity: 1, version: beforeTransfer.version, requestKey: randomUUID() }, admin);
  assert.equal((await warehouse.unit('99000101', admin)).onHand, 3);
  assert.equal((await confirm(file)).unchanged, true);
  await assert.rejects(() => warehouse.scan({ barcode: 'I99000101', action: 'RELEASE', storeId: storeB.id, requestKey: randomUUID() }, tech), /only collect or receive/i);
  await warehouse.finishFactoryPickup(pickup.id, { cycle: 0, partialReason: 'NOT_READY_AT_FACTORY' }, admin);
  const inventory = await warehouse.inventoryByPo({ source: 'EXTERNAL', view: 'all' }, admin);
  assert.equal(inventory.total, 2);
  assert(inventory.items.every(g => g.orderId === null && g.source === 'EXTERNAL'));
  assert.equal((await warehouse.inventoryByPo({ search: 'Inventory check', source: 'EXTERNAL', view: 'all' }, admin)).total, 2);
  const count = await warehouse.startCount({ scope: 'STORE', storeId: storeB.id, requestKey: randomUUID() }, admin);
  await warehouse.countScan(count.id, { barcode: 'I99000101', requestKey: randomUUID() }, admin);
  const countState = await warehouse.count(count.id, {}, admin);
  assert.equal(countState.counted, 1);
  console.log('PASS external multi-PO pickup, receipt, release, undo, transfer, search, stock count and role restrictions');
}

main().catch(error => {
  console.error(error.stderr?.toString() || error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (db) await db.$disconnect();
  if (created) {
    runSql(`DROP DATABASE \`${database}\`;`, false);
    console.log('Disposable test database removed; application data was not changed.');
  }
});
