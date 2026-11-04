// Integration checks use a new disposable LOCAL database with synthetic inventory only.
// Run from backend: node scripts/test-customer-delivery-runs-mysql.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
process.chdir(root);
const envFile = path.join(root, '.env');
const envLine = fs.existsSync(envFile)
  ? fs.readFileSync(envFile, 'utf8').match(/^\s*DATABASE_URL\s*=\s*(.*)$/m) : null;
const configured = process.env.DATABASE_URL || envLine?.[1].trim().replace(/^['"]|['"]$/g, '');
assert(configured, 'A local DATABASE_URL is required.');
const url = new URL(configured);
assert.equal(url.protocol, 'mysql:', 'MySQL only.');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Local MySQL only.');
const database = `impact_delivery_run_check_${Date.now()}_${randomUUID().slice(0, 8)}`;
assert(/^impact_delivery_run_check_\d+_[a-f0-9]{8}$/.test(database));
assert.notEqual(url.pathname, `/${database}`);
const mysql = process.env.MYSQL_BIN || 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe';
const args = ['--protocol=tcp', '--host=127.0.0.1', `--port=${url.port || 3306}`,
  `--user=${decodeURIComponent(url.username)}`, '--default-character-set=utf8mb4', '--batch'];
function sql(statement, useDatabase = true) {
  return execFileSync(mysql, [...args, ...(useDatabase ? [`--database=${database}`] : [])], {
    input: statement, encoding: 'utf8',
    env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) },
    stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
}
const request = () => ({ requestKey: randomUUID() });
const signature = [[{ x: .1, y: .7 }, { x: .2, y: .15 }, { x: .3, y: .65 }, { x: .4, y: .2 }, { x: .6, y: .6 }]];
let created = false, db;

async function main() {
  sql(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`, false);
  created = true;
  const migrations = fs.readdirSync('prisma/migrations', { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  sql(migrations.map(name => fs.readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8')).join('\n'));
  console.log('PASS full migration history applies to disposable MySQL');
  url.pathname = `/${database}`;
  process.env.DATABASE_URL = url.toString();
  process.env.TS_NODE_PROJECT = path.join(root, 'tsconfig.json');
  require('ts-node/register/transpile-only');
  require('tsconfig-paths/register');
  const { PrismaClient } = require('@prisma/client');
  const { WarehouseService } = require('../src/warehouse/warehouse.service');
  const { CustomerDeliveryRunPosDto, CustomerDeliveryRunCreateDto, CustomerDeliveryRunManualDto, CustomerDeliveryRunScanDto, CustomerDeliveryRunRemovePoDto, WarehousePoReleaseDto } = require('../src/warehouse/warehouse.dto');
  const { plainToInstance } = require('class-transformer');
  const { validateSync } = require('class-validator');
  for (const body of [{ poNumbers: ['990010'] }, { poKeys: ['order:1', 'external:2'] }, { ...request(), poKeys: ['external:1'] }])
    assert.equal(validateSync(plainToInstance(CustomerDeliveryRunPosDto, body)).length, 0);
  const malformedChoices = [
    {}, { poNumbers: ['990010'], poKeys: ['external:1'] }, { poNumbers: [] }, { poKeys: [] },
    { poKeys: null }, { poKeys: 'external:1' }, { poKeys: Array(51).fill('external:1') },
    ...['external:0', 'external:01', 'order:-1', 'order:1.5', 'order:9007199254740992',
      'line:1', 'EXTERNAL:1', ' external:1', 'external:1 ', 'order:1e2', 1, null].map(key => ({ poKeys: [key] })),
  ];
  for (const body of malformedChoices)
    assert(validateSync(plainToInstance(CustomerDeliveryRunPosDto, body)).length > 0, `DTO must reject ${JSON.stringify(body)}`);
  for (const body of [request(), { ...request(), storeId: null }, { ...request(), storeId: 1 }, { ...request(), poKeys: ['order:1', 'external:2'] }])
    assert.equal(validateSync(plainToInstance(CustomerDeliveryRunCreateDto, body)).length, 0);
  for (const body of malformedChoices.filter(body => body.poKeys !== undefined && body.poNumbers === undefined))
    assert(validateSync(plainToInstance(CustomerDeliveryRunCreateDto, { ...request(), ...body })).length > 0);
  for (const requestKey of [null, '', 'not-a-uuid', 1])
    assert(validateSync(plainToInstance(CustomerDeliveryRunPosDto, { requestKey, poKeys: ['external:1'] })).length > 0);
  for (const selection of [{}, { storeId: null }, { storeId: 1 }, { runId: 1 }])
    assert.equal(validateSync(plainToInstance(CustomerDeliveryRunManualDto, { ...request(), poKey: 'external:1', ...selection })).length, 0);
  for (const selection of [{ poKey: 'external:01' }, { storeId: 'all' }, { runId: null }, { runId: 0 }, { storeId: 0 }])
    assert(validateSync(plainToInstance(CustomerDeliveryRunManualDto, { ...request(), poKey: 'external:1', ...selection })).length > 0);
  for (const storeId of [1, null])
    assert.equal(validateSync(plainToInstance(WarehousePoReleaseDto, { ...request(), poKey: 'order:1', items: [{ barcode: '99001001', storeId, quantity: 1, version: 0 }] })).length, 0);
  for (const storeId of [undefined, 0, 'all'])
    assert(validateSync(plainToInstance(WarehousePoReleaseDto, { ...request(), poKey: 'order:1', items: [{ barcode: '99001001', storeId, quantity: 1, version: 0 }] })).length > 0);
  for (const storeId of [0, -1, '1', {}, 1.5])
    assert(validateSync(plainToInstance(CustomerDeliveryRunScanDto, { ...request(), barcode: '99001001-DOOR', storeId })).length > 0);
  for (const poKey of ['order:1', 'external:2'])
    assert.equal(validateSync(plainToInstance(CustomerDeliveryRunRemovePoDto, { ...request(), poKey })).length, 0);
  for (const poKey of [undefined, null, '', 'order:0', 'external:01', 'order:-1', 'order:1.5', 'line:1', 'order:9007199254740992', 1])
    assert(validateSync(plainToInstance(CustomerDeliveryRunRemovePoDto, { ...request(), poKey })).length > 0);
  console.log('PASS PO picker DTO accepts exactly one bounded list and rejects malformed source keys');
  db = new PrismaClient({ datasourceUrl: url.toString() });
  const person = async (roleName) => {
    const role = await db.role.upsert({ where: { name: roleName }, create: { name: roleName }, update: {} });
    const user = await db.user.create({ data: { username: `delivery-check-${roleName}`, firstName: 'Synthetic',
      lastName: roleName, password: 'not-a-login', idRole: role.id } });
    return { id: user.id, role: { name: roleName } };
  };
  const admin = await person('admin'), tech = await person('technician'), operator = await person('operator');
  const warehouse = new WarehouseService(db);
  const store = await warehouse.createStore({ name: 'Synthetic delivery test' }, admin);
  const otherStore = await warehouse.createStore({ name: 'Synthetic other location' }, admin);
  const po = async (number, lines) => db.factoryPo.create({ data: {
    poNumber: number, orderName: `Synthetic PO ${number}`, supplierName: 'Synthetic factory',
    externalUnits: { create: lines.map(([lineNumber, description, expectedParts]) => ({
      lineNumber, description, panels: /Door/.test(description) ? expectedParts - 1 : expectedParts,
      stock: { create: { expectedParts } },
    })) },
  } });
  await po('990010', [['99001001', 'French Door panels: 2', 3], ['99001002', 'Fixed Window', 1]]);
  const secondPo = await po('990020', [['99002001', 'Fixed Window', 1]]);
  await po('990030', [['99003001', 'Fixed Window', 2]]);
  const otherOnlyPo = await po('990040', [['99004001', 'Fixed Window', 1]]);
  const transitOnlyPo = await po('990050', [['99005001', 'Fixed Window', 1]]);
  const unassignedPo = await po('990060', [['99006001', 'Fixed Window', 1]]);
  for (const barcode of ['99001001-DOOR', '99001001-DOOR', '99001001-FRAME', '99002001-WINDOW', '99003001-WINDOW'])
    await warehouse.scan({ barcode, action: 'RECEIVE', storeId: store.id, ...request() }, admin);
  await warehouse.scan({ barcode: '99003001-WINDOW', action: 'RECEIVE', storeId: otherStore.id, ...request() }, admin);
  await warehouse.scan({ barcode: '99004001-WINDOW', action: 'RECEIVE', storeId: otherStore.id, ...request() }, admin);
  await db.warehouseStock.update({ where: { lineNumber: '99005001' }, data: { inTransit: 1 } });
  await db.warehouseStock.update({ where: { lineNumber: '99006001' }, data: { onHand: 1, unassigned: 1 } });
  console.log('PASS synthetic typed inventory created, including unreceived PO line and second store');

  const create = (actor = admin, storeId = store.id) => warehouse.startCustomerDeliveryRun({ storeId, ...request() }, actor);
  const read = (id, actor = admin) => warehouse.customerDeliveryRun(id, actor);
  const add = (id, poNumbers, actor = admin) => warehouse.addCustomerDeliveryRunPos(id, { poNumbers }, actor);
  const addKeys = (id, poKeys, actor = admin) => warehouse.addCustomerDeliveryRunPos(id, { poKeys }, actor);
  const scan = (id, barcode, options = {}, actor = admin) => warehouse.scanCustomerDeliveryRun(id, { barcode, ...request(), ...options }, actor);
  const closeBody = (run, overrides = {}) => ({ ...request(), revision: run.revision,
    firstName: 'Synthetic', lastName: 'Recipient', signatureStrokes: signature, acceptPartial: true, ...overrides });
  const quantities = items => items.reduce((total, item) => total + item.quantity, 0);
  const deliveryCount = () => db.warehouseCustomerDelivery.count();
  const stock = lineNumber => db.warehouseStock.findUniqueOrThrow({ where: { lineNumber } });
  const statusCode = expected => error => error.getStatus?.() === expected;

  // Deliberately inconsistent historical PO naming only in this disposable DB.
  // The unrelated commercial graph is omitted; this order has no factory stock.
  sql(`SET FOREIGN_KEY_CHECKS=0;
    INSERT INTO \`Order\` (id, number, units, amount, price, saleSubtotal, rate, netProfit, poNumber, idEst, statusId, userId, paymentId, updatedAt)
    VALUES (950000, 'SYNTHETIC-SAME-NUMBER', 1, 0, 0, 0, 0, 0, '990020', 950000, 950000, ${admin.id}, 950000, CURRENT_TIMESTAMP(3));
    SET FOREIGN_KEY_CHECKS=1;`);
  const internalRegistry = await db.factoryPo.create({ data: { poNumber: '990090', orderId: 950000 } });
  const keyedRun = await create(tech), externalKey = `external:${secondPo.id}`;
  const keyed = await addKeys(keyedRun.id, [externalKey, externalKey], tech);
  assert.equal(keyed.orders.length, 1);
  assert.equal(keyed.orders[0].key, externalKey);
  assert.equal(keyed.orders[0].source, 'EXTERNAL');
  assert.equal(keyed.pendingItems[0].lineNumber, '99002001');
  assert.equal((await addKeys(keyedRun.id, [externalKey], tech)).revision, keyed.revision);
  const selectionRun = await create();
  for (const body of malformedChoices)
    await assert.rejects(() => warehouse.addCustomerDeliveryRunPos(selectionRun.id, body, admin), statusCode(400));
  await assert.rejects(() => addKeys(selectionRun.id, [`external:${transitOnlyPo.id}`]), statusCode(409));
  await assert.rejects(() => addKeys(selectionRun.id, ['order:950000']), statusCode(409));
  await assert.rejects(() => addKeys(selectionRun.id, ['order:950001']), statusCode(404));
  await assert.rejects(() => addKeys(selectionRun.id, [`external:${internalRegistry.id}`]), statusCode(404));
  await assert.rejects(() => addKeys(selectionRun.id, [externalKey, `external:${transitOnlyPo.id}`]), statusCode(409));
  assert.equal((await read(selectionRun.id)).orders.length, 0, 'Mixed unavailable choices must add no POs');
  for (const actor of [operator, { id: admin.id, role: { name: 'client' } }])
    await assert.rejects(() => addKeys(selectionRun.id, [externalKey], actor), statusCode(403));
  const unassignedRun = await create(admin, null);
  await addKeys(unassignedRun.id, [externalKey]);
  assert((await addKeys(unassignedRun.id, [`external:${unassignedPo.id}`])).orders.some(order => order.key === `external:${unassignedPo.id}`));
  const allStorageSelection = await create(tech);
  assert.equal((await addKeys(allStorageSelection.id, [`external:${otherOnlyPo.id}`, `external:${unassignedPo.id}`], tech)).orders.length, 2);
  const pickerQuery = { view: 'on_hand', storeId: String(store.id), completePo: 'true', search: '990020', page: '1', pageSize: '10' };
  for (const options of [await warehouse.inventoryByPo(pickerQuery, admin), await warehouse.technicianWarehouseInventoryByPo(pickerQuery, tech)])
    assert.equal(options.items[0].key, externalKey);
  for (const actor of [admin, tech]) {
    const options = await warehouse.customerDeliveryRunPoOptions(selectionRun.id, { storeId: String(store.id), pageSize: '100' }, actor);
    assert(options.items.some(group => group.key === `external:${otherOnlyPo.id}`));
    assert(options.items.some(group => group.key === `external:${unassignedPo.id}`));
    assert(!options.items.some(group => group.key === `external:${transitOnlyPo.id}`));
    if (actor === tech) assert(options.items.every(group => group.units.every(unit => unit.pieceId === undefined)));
  }
  await assert.rejects(() => warehouse.customerDeliveryRunPoOptions(selectionRun.id, {}, operator), statusCode(403));
  await assert.rejects(() => warehouse.technicianWarehouseInventoryByPo({ view: 'on_hand' }, tech), statusCode(400));
  console.log('PASS exact PO keys preserve source identity across all warehouse locations; transit-only stock and unauthorized roles remain excluded');

  const planningInventory = async () => ({
    stocks: await db.warehouseStock.findMany({ orderBy: { lineNumber: 'asc' } }),
    stores: await db.warehouseStoreStock.findMany({ orderBy: [{ lineNumber: 'asc' }, { storeId: 'asc' }] }),
    movements: await db.warehouseMovement.count(), receipts: await deliveryCount(),
  });
  const beforePlanning = await planningInventory();
  const otherKey = `external:${otherOnlyPo.id}`;
  for (const actor of [admin, tech]) {
    const contextCreation = { ...request(), poKeys: [externalKey, otherKey, externalKey] };
    const simultaneousCreates = await Promise.all([
      warehouse.startCustomerDeliveryRun(contextCreation, actor),
      warehouse.startCustomerDeliveryRun({ ...contextCreation, poKeys: [otherKey, externalKey] }, actor),
    ]);
    const contextual = simultaneousCreates[0];
    assert.equal(simultaneousCreates[1].id, contextual.id, 'Concurrent retries must create one delivery');
    assert.equal(await db.warehouseCustomerDeliveryRun.count({ where: { requestKey: contextCreation.requestKey } }), 1);
    assert.equal(contextual.multiStore, true);
    assert.equal(contextual.storeId, null);
    assert.equal(contextual.items.length, 0);
    assert.deepEqual(contextual.orders.map(order => order.key).sort(), [externalKey, otherKey].sort());
    assert.equal(contextual.orders.find(order => order.key === externalKey).source, 'EXTERNAL', 'The clicked external PO must not resolve to an internal order with the same printed number');
    const replay = { ...contextCreation, poKeys: [otherKey, externalKey] };
    assert.equal((await warehouse.startCustomerDeliveryRun(replay, actor)).id, contextual.id);
    await assert.rejects(() => warehouse.startCustomerDeliveryRun({ ...contextCreation, poKeys: [externalKey] }, actor), statusCode(409));
    await assert.rejects(() => warehouse.startCustomerDeliveryRun({ requestKey: contextCreation.requestKey }, actor), statusCode(409));
    await assert.rejects(() => warehouse.startCustomerDeliveryRun(replay, actor === admin ? tech : admin), statusCode(409));
    await warehouse.removeCustomerDeliveryRunPo(contextual.id, { ...request(), poKey: externalKey }, actor);
    assert(!(await warehouse.startCustomerDeliveryRun(replay, actor)).orders.some(order => order.key === externalKey), 'Create replay must not restore a PO subsequently removed');
    await warehouse.deleteCustomerDeliveryRun(contextual.id, actor);
    await assert.rejects(() => warehouse.startCustomerDeliveryRun(replay, actor), error => {
      assert.equal(error.getStatus(), 409); assert.equal(error.getResponse().code, 'DELIVERY_DELETED'); return true;
    });
  }
  const countBeforeInvalidCreate = await db.warehouseCustomerDeliveryRun.count();
  for (const [poKeys, status] of [
    [[externalKey, `external:${transitOnlyPo.id}`], 409], [[externalKey, 'order:950000'], 409],
    [[externalKey, 'order:950001'], 404], [[`external:${internalRegistry.id}`], 404],
    [[], 400], [null, 400], [['external:01'], 400], [Array(51).fill(externalKey), 400],
  ]) {
    const invalidCreation = { ...request(), poKeys };
    await assert.rejects(() => warehouse.startCustomerDeliveryRun(invalidCreation, admin), statusCode(status));
    assert.equal(await db.warehouseCustomerDeliveryRun.count({ where: { requestKey: invalidCreation.requestKey } }), 0);
  }
  await assert.rejects(() => warehouse.startCustomerDeliveryRun({ ...request(), poKeys: [externalKey], storeId: store.id }, admin), statusCode(400));
  await assert.rejects(() => warehouse.startCustomerDeliveryRun({ ...request(), poKeys: [externalKey] }, operator), statusCode(403));
  assert.equal(await db.warehouseCustomerDeliveryRun.count(), countBeforeInvalidCreate, 'Unavailable or malformed initial POs must not create an empty delivery');
  console.log('PASS contextual create atomically includes exact warehouse POs across locations, preserves retry identity and removals, and cannot resurrect deleted deliveries');

  const keyedAddRun = await warehouse.startCustomerDeliveryRun(request(), tech);
  const keyedAddition = { ...request(), poKeys: [otherKey, externalKey, externalKey] };
  const simultaneousAdds = await Promise.all([
    warehouse.addCustomerDeliveryRunPos(keyedAddRun.id, keyedAddition, tech),
    warehouse.addCustomerDeliveryRunPos(keyedAddRun.id, { ...keyedAddition, poKeys: [externalKey, otherKey] }, tech),
  ]);
  const added = simultaneousAdds[0];
  assert.equal(simultaneousAdds[1].revision, added.revision);
  assert.equal(added.orders.length, 2);
  assert.equal((await warehouse.addCustomerDeliveryRunPos(keyedAddRun.id, { ...keyedAddition, poKeys: [externalKey, otherKey] }, tech)).revision, added.revision);
  assert.equal(await db.warehouseCustomerDeliveryRunEvent.count({ where: { requestKey: keyedAddition.requestKey, action: 'ADD_PO' } }), 1);
  await assert.rejects(() => warehouse.addCustomerDeliveryRunPos(keyedAddRun.id, { ...keyedAddition, poKeys: [externalKey] }, tech), statusCode(409));
  await assert.rejects(() => warehouse.addCustomerDeliveryRunPos(selectionRun.id, keyedAddition, tech), statusCode(409));
  await assert.rejects(() => warehouse.addCustomerDeliveryRunPos(keyedAddRun.id, keyedAddition, admin), statusCode(409));
  const alreadyAdded = { ...request(), poKeys: [externalKey] };
  assert.equal((await warehouse.addCustomerDeliveryRunPos(keyedAddRun.id, alreadyAdded, tech)).revision, added.revision);
  await warehouse.removeCustomerDeliveryRunPo(keyedAddRun.id, { ...request(), poKey: externalKey }, tech);
  for (const operation of [keyedAddition, alreadyAdded])
    assert(!(await warehouse.addCustomerDeliveryRunPos(keyedAddRun.id, operation, tech)).orders.some(order => order.key === externalKey), 'Keyed add replay must not resurrect a later removed PO, including an original no-op');
  assert((await addKeys(keyedAddRun.id, [externalKey], tech)).orders.some(order => order.key === externalKey), 'Legacy additions without request keys remain usable after removal');
  const failedAddition = { ...request(), poKeys: [otherKey, `external:${transitOnlyPo.id}`] };
  const beforeFailedAdd = await read(selectionRun.id);
  await assert.rejects(() => warehouse.addCustomerDeliveryRunPos(selectionRun.id, failedAddition, admin), statusCode(409));
  assert.equal((await read(selectionRun.id)).revision, beforeFailedAdd.revision);
  assert.equal(await db.warehouseCustomerDeliveryRunEvent.count({ where: { requestKey: failedAddition.requestKey } }), 0);
  assert.deepEqual(await planningInventory(), beforePlanning, 'Creating and planning deliveries must not change stock, movements, or receipts');
  console.log('PASS keyed additions are actor/run/PO bound, preserve removals on retries, and keep unkeyed compatibility without changing stock');

  const creation = { storeId: store.id, ...request() };
  const run = await warehouse.startCustomerDeliveryRun(creation, admin);
  assert.equal((await warehouse.startCustomerDeliveryRun(creation, admin)).id, run.id);
  await assert.rejects(() => warehouse.startCustomerDeliveryRun({ ...creation, storeId: otherStore.id }, admin), statusCode(409));
  assert.equal(run.items.length, 0);
  assert.equal(run.orders.length, 0);
  const techRun = await create(tech);
  assert(techRun.id > run.id);
  await assert.rejects(() => create(operator), statusCode(403));
  await assert.rejects(() => create({ id: admin.id, role: { name: 'client' } }), statusCode(403));
  await assert.rejects(() => add(techRun.id, ['990010', 'PO-NOT-PRESENT'], tech), statusCode(404));
  assert.equal((await read(techRun.id, tech)).orders.length, 0);
  await assert.rejects(() => warehouse.closeCustomerDeliveryRun(techRun.id, closeBody(techRun), tech), statusCode(400));
  assert.equal((await create(admin, null)).storeId, null);
  console.log('PASS admin and technician create resumable empty deliveries; other roles are denied; create retries are idempotent');

  await add(run.id, ['990010']);
  await add(run.id, ['990010']);
  let current = await read(run.id);
  assert.equal(current.orders.length, 1);
  assert.equal(current.pendingItems.find(item => item.lineNumber === '99001002').quantity, 1);
  assert.equal(quantities(current.pendingItems), 4);
  const firstScan = { requestKey: randomUUID() };
  await scan(run.id, '99001001-DOOR', firstScan);
  await scan(run.id, '99001001-DOOR', firstScan);
  assert.equal(quantities((await read(run.id)).items), 1);
  assert.equal((await stock('99001001')).onHand, 3);
  assert.equal((await stock('99001001')).released, 0);
  const resumed = await new WarehouseService(db).customerDeliveryRun(run.id, admin);
  assert.equal(resumed.items[0].quantity, 1);
  assert.equal(resumed.items[0].parts.DOOR, 1);
  assert.equal(resumed.pendingItems.find(item => item.lineNumber === '99001001').quantity, 2);
  assert.equal(resumed.pendingItems.find(item => item.lineNumber === '99001002').quantity, 1);
  await assert.rejects(() => scan(run.id, '99001001-FRAME', firstScan), statusCode(409));
  console.log('PASS saved scans survive a new service instance, retain typed parts, and do not release inventory before signature');

  const correction = { barcode: '99001001-DOOR', ...request() };
  await warehouse.removeCustomerDeliveryRunPart(run.id, correction, admin);
  await warehouse.removeCustomerDeliveryRunPart(run.id, correction, admin);
  assert.equal(quantities((await read(run.id)).items), 0);
  assert.equal(quantities((await read(run.id)).pendingItems), 4);
  await assert.rejects(() => warehouse.removeCustomerDeliveryRunPart(run.id, { barcode: '99001001-FRAME', ...request() }, admin), statusCode(400));
  await scan(run.id, '99001001-DOOR');
  console.log('PASS explicit one-part correction is durable, typed, and idempotent without changing stock');

  const beforeExcluded = await read(run.id);
  await assert.rejects(() => scan(run.id, '99002001-WINDOW'), error => {
    assert.equal(error.getStatus(), 409);
    assert.equal(error.getResponse().code, 'DELIVERY_PO_NOT_INCLUDED');
    return true;
  });
  const afterExcluded = await read(run.id);
  assert.deepEqual(afterExcluded.items, beforeExcluded.items);
  assert.deepEqual(afterExcluded.orders, beforeExcluded.orders);
  await scan(run.id, '99002001-WINDOW', { addPo: true });
  current = await read(run.id);
  assert.equal(current.orders.length, 2);
  assert.equal(current.items.find(item => item.lineNumber === '99002001').quantity, 1);
  await assert.rejects(() => scan(run.id, '99002001-WINDOW'), statusCode(400));
  console.log('PASS excluded PO scan leaves delivery unchanged; explicit inclusion saves PO and piece atomically');

  const sharedKey = { requestKey: randomUUID() };
  await Promise.all([scan(run.id, '99001001-DOOR', sharedKey), scan(run.id, '99001001-DOOR', sharedKey)]);
  current = await read(run.id);
  assert.equal(current.items.find(item => item.lineNumber === '99001001').parts.DOOR, 2);
  await assert.rejects(() => scan(run.id, '99001001-DOOR'), statusCode(400));
  assert.equal((await stock('99001001')).onHand, 3);
  console.log('PASS simultaneous retry of one scan cannot double-count or exceed available door panels');

  const reviewed = await read(run.id);
  await scan(run.id, '99001001-FRAME');
  const receiptCount = await deliveryCount();
  await assert.rejects(() => warehouse.closeCustomerDeliveryRun(run.id, closeBody(reviewed), admin), statusCode(409));
  assert.equal(await deliveryCount(), receiptCount);
  assert.equal((await stock('99001001')).released, 0);
  current = await read(run.id);
  await assert.rejects(() => warehouse.closeCustomerDeliveryRun(run.id, closeBody(current, { acceptPartial: false }), admin), statusCode(409));
  await assert.rejects(() => warehouse.closeCustomerDeliveryRun(run.id, closeBody(current, { signatureStrokes: [] }), admin), statusCode(400));
  assert.equal(await deliveryCount(), receiptCount);
  assert.equal(quantities((await read(run.id)).pendingItems), 1);
  console.log('PASS changed review, unacknowledged partial PO, and missing signature cannot close or release any stock');

  const finalBody = closeBody(current);
  await Promise.all([
    warehouse.closeCustomerDeliveryRun(run.id, finalBody, admin),
    warehouse.closeCustomerDeliveryRun(run.id, finalBody, admin),
  ]);
  const finished = await read(run.id);
  const receiptId = finished.deliveryId;
  assert(Number.isSafeInteger(receiptId));
  const receipt = await warehouse.customerDelivery(receiptId, admin);
  assert.equal(receipt.totalPieces, 2);
  assert.equal(receipt.totalParts, 4);
  assert.equal(receipt.pendingItems.find(item => item.lineNumber === '99001002').quantity, 1);
  assert.equal(quantities(receipt.pendingItems), 1);
  assert.equal(receipt.orders.length, 2);
  assert.equal((await stock('99001001')).onHand, 0);
  assert.equal((await stock('99001001')).released, 3);
  assert.equal((await stock('99002001')).released, 1);
  const depletedKeyedRun = await read(keyedRun.id, tech);
  assert.equal((await addKeys(keyedRun.id, [externalKey, externalKey], tech)).revision, depletedKeyedRun.revision);
  await assert.rejects(() => addKeys(selectionRun.id, [externalKey]), statusCode(409));
  await warehouse.closeCustomerDeliveryRun(run.id, finalBody, admin);
  assert.equal(await deliveryCount(), receiptCount + 1);
  assert.equal(await db.warehouseMovement.count({ where: { customerDeliveryId: receiptId } }), 2);
  await assert.rejects(() => scan(run.id, '99001002-WINDOW'), statusCode(409));
  await assert.rejects(() => add(run.id, ['990030']), statusCode(409));
  console.log('PASS signed close releases exact scanned stock once and freezes delivered/pending receipt');

  await warehouse.scan({ barcode: '99001002-WINDOW', action: 'RECEIVE', storeId: store.id, ...request() }, admin);
  const pendingRun = await create(tech);
  await add(pendingRun.id, ['990010'], tech);
  await scan(pendingRun.id, '99001002-WINDOW', {}, tech);
  const pendingReview = await read(pendingRun.id, tech);
  assert.equal(quantities(pendingReview.pendingItems), 0);
  await warehouse.closeCustomerDeliveryRun(pendingRun.id, closeBody(pendingReview, { acceptPartial: false }), tech);
  const laterReceipt = await warehouse.customerDelivery(receiptId, admin);
  assert.deepEqual(laterReceipt, receipt);
  assert.deepEqual((await read(run.id)).pendingItems, finished.pendingItems);
  console.log('PASS technicians complete a later pickup; prior signed pending snapshot remains unchanged');

  const locationRun = await create();
  await add(locationRun.id, ['990030']);
  const race = await Promise.allSettled([scan(locationRun.id, '99003001-WINDOW'), scan(locationRun.id, '99003001-WINDOW')]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(quantities((await read(locationRun.id)).items), 1);
  assert.equal(quantities((await read(locationRun.id)).pendingItems), 1);
  const stockReview = await read(locationRun.id);
  await warehouse.scan({ barcode: '99003001-WINDOW', action: 'RELEASE', storeId: store.id, ...request() }, admin);
  const countBeforeConflict = await deliveryCount();
  await assert.rejects(() => warehouse.closeCustomerDeliveryRun(locationRun.id, closeBody(stockReview), admin), statusCode(409));
  assert.equal(await deliveryCount(), countBeforeConflict);
  assert.equal((await stock('99003001')).onHand, 1);
  assert.equal((await stock('99003001')).released, 1);
  console.log('PASS concurrent scans obey selected-store balance, and changed stock invalidates signed review atomically');

  const multiPo = await po('990070', [
    ['99007001', 'French Door panels: 2', 3], ['99007002', 'Fixed Window', 2], ['99007003', 'Pending Window', 1],
  ]);
  for (const [barcode, storeId] of [
    ['99007001-DOOR', store.id], ['99007001-FRAME', store.id], ['99007001-DOOR', otherStore.id],
    ['99007002-WINDOW', store.id], ['99007002-WINDOW', otherStore.id],
  ]) await warehouse.scan({ barcode, action: 'RECEIVE', storeId, ...request() }, admin);
  const multiCreation = request();
  const multi = await warehouse.startCustomerDeliveryRun(multiCreation, admin);
  assert.equal(multi.multiStore, true);
  assert.equal((await warehouse.startCustomerDeliveryRun(multiCreation, admin)).id, multi.id);
  await assert.rejects(() => warehouse.startCustomerDeliveryRun({ ...multiCreation, storeId: null }, admin), statusCode(409));
  await addKeys(multi.id, [`external:${multiPo.id}`]);
  await assert.rejects(() => scan(multi.id, '99007001-DOOR'), error => {
    assert.equal(error.getStatus(), 400); assert.equal(error.getResponse().code, 'DELIVERY_STORE_REQUIRED'); return true;
  });
  const sourceKey = request();
  await scan(multi.id, '99007001-DOOR', { ...sourceKey, storeId: store.id });
  await scan(multi.id, '99007001-DOOR', { ...sourceKey, storeId: store.id });
  await assert.rejects(() => scan(multi.id, '99007001-DOOR', { ...sourceKey, storeId: otherStore.id }), statusCode(409));
  await assert.rejects(() => scan(multi.id, '99007001-DOOR', { storeId: store.id }), statusCode(400));
  await scan(multi.id, '99007001-DOOR', { storeId: otherStore.id });
  const mixedDoors = await new WarehouseService(db).customerDeliveryRun(multi.id, tech);
  assert.equal(mixedDoors.totalPieces, 1);
  assert.equal(mixedDoors.totalParts, 2);
  assert.equal(mixedDoors.allocations.length, 2);
  assert.equal(mixedDoors.items[0].origins.length, 2);
  assert.equal(mixedDoors.pendingItems.find(item => item.lineNumber === '99007001').quantity, 1);
  assert.deepEqual(mixedDoors.pendingItems.find(item => item.lineNumber === '99007001').parts, { FRAME: 1 });
  const sourceCorrection = { ...request(), barcode: '99007001-DOOR', storeId: store.id };
  await warehouse.removeCustomerDeliveryRunPart(multi.id, sourceCorrection, admin);
  await warehouse.removeCustomerDeliveryRunPart(multi.id, sourceCorrection, admin);
  await assert.rejects(() => warehouse.removeCustomerDeliveryRunPart(multi.id, { ...sourceCorrection, storeId: otherStore.id }, admin), statusCode(409));
  assert.deepEqual((await read(multi.id)).allocations.map(line => line.storeId), [otherStore.id]);
  await scan(multi.id, '99007001-DOOR', { storeId: store.id });
  await scan(multi.id, '99007001-FRAME', { storeId: store.id });
  await scan(multi.id, '99007002-WINDOW', { storeId: store.id });
  await scan(multi.id, '99007002-WINDOW', { storeId: otherStore.id });
  const multiReview = await read(multi.id);
  assert.equal(multiReview.totalPieces, 2);
  assert.equal(multiReview.totalParts, 5);
  assert.equal(multiReview.allocations.length, 4);
  assert.equal(multiReview.pendingParts, 1);
  await assert.rejects(() => warehouse.closeCustomerDeliveryRun(multi.id, closeBody(mixedDoors), admin), statusCode(409));
  const stockBeforeMulti = [await stock('99007001'), await stock('99007002')];
  const receiptsBeforeMulti = await deliveryCount();
  const failingWarehouse = new WarehouseService(db);
  const realMove = failingWarehouse.move.bind(failingWarehouse);
  let moveCalls = 0;
  failingWarehouse.move = async (...args) => {
    if (++moveCalls === 2) throw new Error('Synthetic second source failure');
    return realMove(...args);
  };
  await assert.rejects(() => failingWarehouse.closeCustomerDeliveryRun(multi.id, closeBody(multiReview), admin), /Synthetic second source failure/);
  assert.deepEqual([await stock('99007001'), await stock('99007002')], stockBeforeMulti);
  assert.equal(await deliveryCount(), receiptsBeforeMulti);
  assert.equal((await read(multi.id)).status, 'ACTIVE');
  const multiClose = closeBody(multiReview);
  await Promise.all([
    warehouse.closeCustomerDeliveryRun(multi.id, multiClose, admin),
    warehouse.closeCustomerDeliveryRun(multi.id, multiClose, admin),
  ]);
  const multiClosed = await read(multi.id);
  assert.equal(multiClosed.delivery.totalPieces, 2);
  assert.equal(multiClosed.delivery.totalParts, 5);
  assert.equal(multiClosed.delivery.storeId, null);
  assert.equal(multiClosed.delivery.storeName, 'Multiple locations');
  assert.equal(multiClosed.delivery.items.find(item => item.lineNumber === '99007001').origins.length, 2);
  assert.equal(multiClosed.delivery.pendingItems[0].lineNumber, '99007003');
  assert.equal(await deliveryCount(), receiptsBeforeMulti + 1);
  const multiMovements = await db.warehouseMovement.findMany({ where: { customerDeliveryId: multiClosed.deliveryId }, orderBy: { id: 'asc' } });
  assert.equal(multiMovements.length, 4);
  assert.equal(new Set(multiMovements.map(movement => movement.requestKey)).size, 4);
  assert.equal(multiMovements.filter(movement => movement.fromStoreId === store.id).reduce((sum, movement) => sum + movement.quantity, 0), 3);
  assert.equal(multiMovements.filter(movement => movement.fromStoreId === otherStore.id).reduce((sum, movement) => sum + movement.quantity, 0), 2);
  for (const lineNumber of ['99007001', '99007002']) {
    assert.equal((await stock(lineNumber)).onHand, 0);
    assert((await db.warehouseStoreStock.findMany({ where: { lineNumber } })).every(balance => balance.onHand === 0));
  }
  console.log('PASS one signed delivery aggregates same-piece scans across stores, corrects exact origins, and atomically releases each source with rollback and retry protection');

  const legacyPo = await po('990080', [['99008001', 'French Door panels: 2', 3]]);
  await db.warehouseStock.update({ where: { lineNumber: '99008001' }, data: { onHand: 3 } });
  await db.warehouseStoreStock.createMany({ data: [
    { lineNumber: '99008001', storeId: store.id, onHand: 2 },
    { lineNumber: '99008001', storeId: otherStore.id, onHand: 1 },
  ] });
  const legacyCreation = { ...request(), storeId: store.id };
  const legacyRun = await warehouse.startCustomerDeliveryRun(legacyCreation, tech);
  await add(legacyRun.id, ['990080'], tech);
  const legacyReadKey = request();
  await scan(legacyRun.id, '99008001-DOOR', legacyReadKey, tech);
  // Emulate a row saved before origin fields existed, preserving its old event hash.
  const rawLegacy = await db.warehouseCustomerDeliveryRun.findUniqueOrThrow({ where: { id: legacyRun.id } });
  await db.warehouseCustomerDeliveryRun.update({ where: { id: legacyRun.id }, data: {
    items: rawLegacy.items.map(({ storeId: _storeId, storeName: _storeName, ...line }) => line), multiStore: false,
  } });
  const legacyBeforeUpgrade = await read(legacyRun.id, tech);
  assert.equal(legacyBeforeUpgrade.multiStore, false);
  assert.equal(legacyBeforeUpgrade.allocations[0].storeId, store.id);
  await addKeys(legacyRun.id, [`external:${legacyPo.id}`], tech);
  const upgraded = await read(legacyRun.id, tech);
  assert.equal(upgraded.multiStore, true);
  assert.equal(upgraded.allocations[0].storeId, store.id);
  assert.equal(upgraded.items[0].quantity, 1);
  assert.equal((await warehouse.startCustomerDeliveryRun(legacyCreation, tech)).id, legacyRun.id);
  await scan(legacyRun.id, '99008001-DOOR', legacyReadKey, tech);
  assert.equal((await read(legacyRun.id, tech)).totalParts, 1);
  await assert.rejects(() => scan(legacyRun.id, '99008001-DOOR', {}, tech), statusCode(400));
  await scan(legacyRun.id, '99008001-DOOR', { storeId: store.id }, tech);
  // Each location has sufficient unclassified quantity, but the combined typed
  // selection must still obey the one piece's two-panel/one-frame definition.
  await assert.rejects(() => scan(legacyRun.id, '99008001-DOOR', { storeId: otherStore.id }, tech), statusCode(400));
  await scan(legacyRun.id, '99008001-FRAME', { storeId: otherStore.id }, tech);
  const legacyMultiReview = await read(legacyRun.id, tech);
  assert.equal(legacyMultiReview.totalPieces, 1);
  assert.equal(legacyMultiReview.pendingParts, 0);
  const legacyMultiClose = closeBody(legacyMultiReview, { acceptPartial: false });
  await warehouse.closeCustomerDeliveryRun(legacyRun.id, legacyMultiClose, tech);
  await scan(legacyRun.id, '99008001-DOOR', legacyReadKey, tech);
  assert.equal((await read(legacyRun.id, tech)).status, 'CLOSED');
  assert.equal((await stock('99008001')).released, 3);
  console.log('PASS legacy no-origin scans upgrade without loss, omitted-source retries survive upgrade and close, and typed totals stay valid across unclassified stores');

  const unassignedMulti = await warehouse.startCustomerDeliveryRun(request(), tech);
  await addKeys(unassignedMulti.id, [`external:${unassignedPo.id}`, `external:${otherOnlyPo.id}`], tech);
  await scan(unassignedMulti.id, '99006001-WINDOW', { storeId: null }, tech);
  await scan(unassignedMulti.id, '99004001-WINDOW', { storeId: otherStore.id }, tech);
  const unassignedReview = await read(unassignedMulti.id, tech);
  const unassignedClosed = await warehouse.closeCustomerDeliveryRun(unassignedMulti.id, closeBody(unassignedReview), tech);
  assert.equal(unassignedClosed.delivery.totalPieces, 2);
  assert.equal((await stock('99006001')).unassigned, 0);
  const unassignedMovement = await db.warehouseMovement.findFirstOrThrow({ where: { customerDeliveryId: unassignedClosed.deliveryId, lineNumber: '99006001' } });
  assert.equal(unassignedMovement.fromStoreId, null);

  // Historical closed summaries and receipts remain readable without rewriting
  // their stored signature, revision, items or locations.
  const historical = await db.warehouseCustomerDeliveryRun.findUniqueOrThrow({ where: { id: run.id } });
  const oldSnapshot = { ...historical.snapshot };
  delete oldSnapshot.multiStore; delete oldSnapshot.allocations;
  oldSnapshot.items = oldSnapshot.items.map(({ origins: _origins, ...item }) => item);
  await db.warehouseCustomerDeliveryRun.update({ where: { id: run.id }, data: { snapshot: oldSnapshot } });
  const oldReceipt = await db.warehouseCustomerDelivery.findUniqueOrThrow({ where: { id: receiptId } });
  await db.warehouseCustomerDelivery.update({ where: { id: receiptId }, data: { items: oldReceipt.items.map(({ origins: _origins, ...item }) => item) } });
  const historicalBeforeRead = await warehouse.customerDelivery(receiptId, admin);
  const historicalRead = await read(run.id);
  assert.equal(historicalRead.allocations.length, historicalRead.totalPieces);
  assert.equal(historicalRead.revision, oldSnapshot.revision);
  await warehouse.closeCustomerDeliveryRun(run.id, finalBody, admin);
  assert.deepEqual(await warehouse.customerDelivery(receiptId, admin), historicalBeforeRead);
  console.log('PASS unassigned and named origins share one receipt; historical closed receipts and close retries remain unchanged');

  // Deleting preparation and correcting its planned POs must never release or
  // erase stock. All fixtures below remain in this disposable database only.
  const removablePo = await po('990100', [['99010001', 'Fixed Window', 2]]);
  const sparePo = await po('990110', [['99011001', 'Fixed Window', 1]]);
  const removableKey = `external:${removablePo.id}`, spareKey = `external:${sparePo.id}`;
  for (const [barcode, storeId] of [
    ['99010001-WINDOW', store.id], ['99010001-WINDOW', otherStore.id], ['99011001-WINDOW', store.id],
  ]) await warehouse.scan({ barcode, action: 'RECEIVE', storeId, ...request() }, admin);
  const immutableInventory = async () => ({
    stocks: await db.warehouseStock.findMany({ orderBy: { lineNumber: 'asc' } }),
    stores: await db.warehouseStoreStock.findMany({ orderBy: [{ lineNumber: 'asc' }, { storeId: 'asc' }] }),
    movements: await db.warehouseMovement.count(), receipts: await deliveryCount(),
  });
  const beforeCorrections = await immutableInventory();
  const removePo = (id, poKey, actor = admin, identity = request()) => warehouse.removeCustomerDeliveryRunPo(id, { ...identity, poKey }, actor);
  const erase = (id, actor = admin) => warehouse.deleteCustomerDeliveryRun(id, actor);

  for (const actor of [admin, tech]) {
    const emptyCreation = request();
    const empty = await warehouse.startCustomerDeliveryRun(emptyCreation, actor);
    assert.equal(empty.canDelete, true);
    const planned = await addKeys(empty.id, [removableKey], actor);
    assert.equal(planned.canDelete, true, 'Adding a PO alone must not prevent deletion');
    assert.equal(planned.orders[0].canRemove, true);
    for (const denied of [operator, { id: admin.id, role: { name: 'client' } }]) {
      await assert.rejects(() => erase(empty.id, denied), statusCode(403));
      await assert.rejects(() => removePo(empty.id, removableKey, denied), statusCode(403));
    }
    assert.deepEqual(await erase(empty.id, actor), { id: empty.id, deleted: true });
    assert.deepEqual(await erase(empty.id, actor), { id: empty.id, deleted: true });
    assert.equal((await db.warehouseCustomerDeliveryRun.findUniqueOrThrow({ where: { id: empty.id } })).status, 'DELETED');
    assert.equal(await db.warehouseCustomerDeliveryRunEvent.count({ where: { runId: empty.id, action: 'DELETE' } }), 1);
    for (const status of [undefined, 'ACTIVE', 'CLOSED']) {
      const visible = await warehouse.customerDeliveryRuns({ pageSize: '50', ...(status ? { status } : {}) }, actor);
      assert(!visible.items.some(delivery => delivery.id === empty.id));
    }
    await assert.rejects(() => read(empty.id, actor), statusCode(404));
    await assert.rejects(() => warehouse.customerDeliveryRunPoOptions(empty.id, {}, actor), statusCode(404));
    await assert.rejects(() => addKeys(empty.id, [spareKey], actor), statusCode(404));
    await assert.rejects(() => scan(empty.id, '99010001-WINDOW', { storeId: store.id }, actor), statusCode(404));
    await assert.rejects(() => removePo(empty.id, removableKey, actor), statusCode(404));
    await assert.rejects(() => warehouse.closeCustomerDeliveryRun(empty.id, closeBody(planned), actor), statusCode(404));
    await assert.rejects(() => warehouse.startCustomerDeliveryRun(emptyCreation, actor), error => {
      assert.equal(error.getStatus(), 409); assert.equal(error.getResponse().code, 'DELIVERY_DELETED'); return true;
    });
  }
  console.log('PASS admin and technician delete unscanned deliveries with POs; deletion is audited, repeatable, hidden, and cannot be resurrected by a create retry');

  const removable = await warehouse.startCustomerDeliveryRun(request(), tech);
  await addKeys(removable.id, [removableKey, spareKey], tech);
  await scan(removable.id, '99010001-WINDOW', { storeId: store.id }, tech);
  await scan(removable.id, '99010001-WINDOW', { storeId: otherStore.id }, tech);
  const scanned = await read(removable.id, tech);
  assert.equal(scanned.canDelete, false);
  assert.equal(scanned.orders.find(order => order.key === removableKey).canRemove, false);
  assert.equal(scanned.orders.find(order => order.key === spareKey).canRemove, true);
  await assert.rejects(() => erase(removable.id, tech), statusCode(409));
  await assert.rejects(() => removePo(removable.id, removableKey, tech), statusCode(409));
  const beforePoRemoval = await read(removable.id, tech);
  const removalIdentity = request();
  const removed = await removePo(removable.id, spareKey, tech, removalIdentity);
  assert.deepEqual(removed.items, beforePoRemoval.items);
  assert.deepEqual(removed.allocations, beforePoRemoval.allocations);
  assert(!removed.orders.some(order => order.key === spareKey));
  assert(!removed.pendingItems.some(item => item.lineNumber === '99011001'));
  assert.notEqual(removed.revision, beforePoRemoval.revision);
  await addKeys(removable.id, [spareKey], tech);
  const readded = await read(removable.id, tech);
  const replayed = await removePo(removable.id, spareKey, tech, removalIdentity);
  assert.equal(replayed.revision, readded.revision);
  assert(replayed.orders.some(order => order.key === spareKey), 'Uncertain removal retry must not remove a later re-add');
  assert.equal(await db.warehouseCustomerDeliveryRunEvent.count({ where: { requestKey: removalIdentity.requestKey } }), 1);
  await assert.rejects(() => removePo(removable.id, removableKey, tech, removalIdentity), statusCode(409));
  await assert.rejects(() => removePo(removable.id, spareKey, admin, removalIdentity), statusCode(409));
  await removePo(removable.id, spareKey, admin);
  const absentIdentity = request();
  await removePo(removable.id, spareKey, admin, absentIdentity);
  await addKeys(removable.id, [spareKey]);
  assert((await removePo(removable.id, spareKey, admin, absentIdentity)).orders.some(order => order.key === spareKey));
  for (const storeId of [store.id, otherStore.id])
    await warehouse.removeCustomerDeliveryRunPart(removable.id, { ...request(), barcode: '99010001-WINDOW', storeId }, tech);
  const corrected = await read(removable.id, tech);
  assert.equal(corrected.totalParts, 0);
  assert.equal(corrected.canDelete, false, 'Correcting all readings must not erase the scan history');
  assert.equal(corrected.orders.find(order => order.key === removableKey).canRemove, true);
  await assert.rejects(() => erase(removable.id, tech), statusCode(409));
  assert(!(await removePo(removable.id, removableKey, tech)).orders.some(order => order.key === removableKey));
  for (const poKey of ['', 'order:0', 'external:01', 'line:1', null])
    await assert.rejects(() => removePo(removable.id, poKey, tech), statusCode(400));
  assert.equal((await read(run.id)).canDelete, false);
  assert((await read(run.id)).orders.every(order => order.canRemove === false));
  await assert.rejects(() => erase(run.id, admin), statusCode(409));
  await assert.rejects(() => removePo(run.id, externalKey, tech), statusCode(409));
  console.log('PASS PO removal preserves other scans, updates pending totals, survives uncertain retries and re-adds, and blocks scanned POs and closed receipts');

  const deleteRaceRun = await warehouse.startCustomerDeliveryRun(request(), admin);
  await addKeys(deleteRaceRun.id, [removableKey]);
  const deleteRace = await Promise.allSettled([
    erase(deleteRaceRun.id), scan(deleteRaceRun.id, '99010001-WINDOW', { storeId: store.id }),
  ]);
  assert.equal(deleteRace.filter(result => result.status === 'fulfilled').length, 1);
  const deleteRaceRecord = await db.warehouseCustomerDeliveryRun.findUniqueOrThrow({ where: { id: deleteRaceRun.id } });
  if (deleteRaceRecord.status === 'DELETED') {
    assert.equal(await db.warehouseCustomerDeliveryRunEvent.count({ where: { runId: deleteRaceRun.id, action: 'SCAN' } }), 0);
  } else {
    assert.equal(deleteRaceRecord.status, 'ACTIVE');
    assert.equal((await read(deleteRaceRun.id)).totalParts, 1);
    assert.equal((await read(deleteRaceRun.id)).canDelete, false);
  }
  const poRaceRun = await warehouse.startCustomerDeliveryRun(request(), tech);
  await addKeys(poRaceRun.id, [removableKey], tech);
  const poRace = await Promise.allSettled([
    removePo(poRaceRun.id, removableKey, tech), scan(poRaceRun.id, '99010001-WINDOW', { storeId: otherStore.id }, tech),
  ]);
  assert.equal(poRace.filter(result => result.status === 'fulfilled').length, 1);
  const poRaceResult = await read(poRaceRun.id, tech);
  assert.equal(poRaceResult.orders.some(order => order.key === removableKey), poRaceResult.totalParts === 1);
  assert.deepEqual(await immutableInventory(), beforeCorrections);
  console.log('PASS simultaneous deletion/removal and scanning serialize safely; all planning corrections leave inventory, movements and signed receipts untouched');

  const manualPo = await po('990120', [
    ['99012001', 'French Door panels: 2', 3], ['99012002', 'Fixed Window', 2], ['99012003', 'Pending Window', 1],
  ]);
  const manualKey = `external:${manualPo.id}`;
  for (const [barcode, storeId] of [
    ['99012001-DOOR', store.id], ['99012001-FRAME', store.id], ['99012001-DOOR', otherStore.id],
    ['99012002-WINDOW', store.id], ['99012002-WINDOW', otherStore.id],
  ]) await warehouse.scan({ barcode, action: 'RECEIVE', storeId, ...request() }, admin);
  await db.warehouseStock.update({ where: { lineNumber: '99012003' }, data: { inTransit: 1 } });
  await db.order.update({ where: { id: 950000 }, data: { poNumber: '990120' } });
  const manual = (body, actor = admin) => warehouse.recordManualCustomerDeliveryRun({ ...request(), poKey: manualKey, ...body }, actor);
  const beforeManual = await immutableInventory();
  const manualIdentity = { ...request(), poKey: manualKey };
  const manualRace = await Promise.all([manual(manualIdentity), manual(manualIdentity)]);
  const manualCreated = manualRace[0];
  assert.equal(manualRace[1].id, manualCreated.id);
  assert.equal(manualCreated.orders[0].key, manualKey, 'Manual PO must preserve the exact external source despite the duplicate printed PO');
  assert.equal(manualCreated.totalPieces, 2);
  assert.equal(manualCreated.totalParts, 5);
  assert.equal(manualCreated.allocations.length, 4);
  assert.deepEqual(manualCreated.items.find(item => item.lineNumber === '99012001').parts, { DOOR: 2, FRAME: 1, WINDOW: 0, UNKNOWN: 0 });
  assert.equal(manualCreated.pendingParts, 1, 'Transit-only stock must remain pending');
  assert.equal(manualCreated.canDelete, false);
  assert.equal(await db.warehouseCustomerDeliveryRunEvent.count({ where: { runId: manualCreated.id, action: 'MANUAL' } }), 1);
  assert.equal(await db.warehouseCustomerDeliveryRunEvent.count({ where: { runId: manualCreated.id, action: 'SCAN' } }), 0);
  for (const change of [{ storeId: store.id }, { runId: manualCreated.id }, { poKey: spareKey }])
    await assert.rejects(() => manual({ ...manualIdentity, ...change }), statusCode(409));
  await assert.rejects(() => manual(manualIdentity, tech), statusCode(409));
  assert.equal((await manual({ runId: manualCreated.id })).totalParts, 5, 'A new manual action on the same PO must not double-count it');
  const manualScoped = await manual({ storeId: store.id }, tech);
  assert.equal(manualScoped.totalParts, 3);
  assert(manualScoped.allocations.every(line => line.storeId === store.id));
  assert.equal((await manual({ runId: manualScoped.id }, tech)).totalParts, 5, 'All-location action fills the other storage without repeating saved parts');
  const manualScanned = await create(tech);
  await addKeys(manualScanned.id, [manualKey, spareKey], tech);
  await scan(manualScanned.id, '99012001-DOOR', { storeId: store.id }, tech);
  assert.equal((await manual({ runId: manualScanned.id }, tech)).totalParts, 5, 'Manual action fills only residual stock after a typed scan');
  assert((await read(manualScanned.id)).orders.some(order => order.key === spareKey));
  const countBeforeManualFailure = await db.warehouseCustomerDeliveryRun.count();
  for (const body of [{ poKey: `external:${transitOnlyPo.id}` }, { poKey: 'order:950000' }, { storeId: null }])
    await assert.rejects(() => manual(body), statusCode(409));
  for (const body of [{ poKey: 'external:01' }, { runId: null }, { storeId: 'all' }])
    await assert.rejects(() => manual(body), statusCode(400));
  await assert.rejects(() => manual({}, operator), statusCode(403));
  assert.equal(await db.warehouseCustomerDeliveryRun.count(), countBeforeManualFailure);
  assert.deepEqual(await immutableInventory(), beforeManual, 'Manual recording must not change stock, movements or receipts before signature');
  for (const [barcode, storeId] of [
    ['99012001-DOOR', store.id], ['99012001-FRAME', store.id], ['99012001-DOOR', otherStore.id],
    ['99012002-WINDOW', store.id], ['99012002-WINDOW', otherStore.id],
  ]) await warehouse.removeCustomerDeliveryRunPart(manualCreated.id, { ...request(), barcode, storeId }, admin);
  await removePo(manualCreated.id, manualKey);
  const manualReplayed = await manual(manualIdentity);
  assert.equal(manualReplayed.totalParts, 0);
  assert.equal(manualReplayed.orders.length, 0, 'Uncertain manual retry must not restore subsequently removed selections');
  assert.equal(manualReplayed.canDelete, false, 'Correcting manual parts to zero must preserve their audit history');
  await assert.rejects(() => erase(manualCreated.id), statusCode(409));
  console.log('PASS manual PO action fills exact typed stock across locations, skips transit, respects filters and existing scans, preserves corrections on replay, and audits without stock movements');

  const unknownManualPo = await po('990130', [['99013001', 'Fixed Window', 1]]);
  await db.warehouseStock.update({ where: { lineNumber: '99013001' }, data: { onHand: 1, unassigned: 1 } });
  const unassignedManual = await manual({ poKey: `external:${unknownManualPo.id}`, storeId: null }, tech);
  assert.deepEqual(unassignedManual.items[0].parts, { DOOR: 0, FRAME: 0, WINDOW: 1, UNKNOWN: 0 });
  assert.equal(unassignedManual.allocations[0].storeId, null);
  const ambiguousManualPo = await po('990140', [['99014001', 'Fixed Window', 1], ['99014002', 'French Door panels: 2', 3]]);
  await warehouse.scan({ barcode: '99014001-WINDOW', action: 'RECEIVE', storeId: store.id, ...request() }, admin);
  await db.warehouseStock.update({ where: { lineNumber: '99014002' }, data: { onHand: 1, unassigned: 1 } });
  const ambiguousBody = { ...request(), poKey: `external:${ambiguousManualPo.id}` };
  const beforeAmbiguous = await read(manualScanned.id);
  for (const selection of [ambiguousBody, { ...ambiguousBody, ...request(), runId: manualScanned.id }]) {
    await assert.rejects(() => manual(selection), error => {
      assert.equal(error.getStatus(), 409); assert.equal(error.getResponse().code, 'DELIVERY_MANUAL_TYPES_REQUIRED'); return true;
    });
    assert.equal(await db.warehouseCustomerDeliveryRun.count({ where: { requestKey: selection.requestKey } }), 0);
    assert.equal(await db.warehouseCustomerDeliveryRunEvent.count({ where: { requestKey: selection.requestKey } }), 0);
  }
  assert.equal((await read(manualScanned.id)).revision, beforeAmbiguous.revision, 'A later ambiguous piece must roll back the whole manual addition');
  const physicalCount = await db.warehouseCount.create({ data: { ...request(), activeSlot: 1, startedById: admin.id } });
  await assert.rejects(() => manual({}), statusCode(409));
  assert.equal((await manual(manualIdentity)).id, manualCreated.id, 'Successful replay remains available during a physical count');
  await db.warehouseCount.update({ where: { id: physicalCount.id }, data: { activeSlot: null } });
  const manualBeforeClose = await read(manualScoped.id, tech);
  const stockBeforeManualClose = await immutableInventory();
  await assert.rejects(() => warehouse.closeCustomerDeliveryRun(manualScoped.id, closeBody(manualBeforeClose, { signatureStrokes: [] }), tech), statusCode(400));
  await assert.rejects(() => warehouse.closeCustomerDeliveryRun(manualScoped.id, closeBody(manualBeforeClose, { acceptPartial: false }), tech), statusCode(409));
  assert.deepEqual(await immutableInventory(), stockBeforeManualClose);
  const manualCloseBody = closeBody(manualBeforeClose);
  const manualClosed = await warehouse.closeCustomerDeliveryRun(manualScoped.id, manualCloseBody, tech);
  assert.equal(manualClosed.status, 'CLOSED');
  assert.equal(manualClosed.totalParts, 5);
  assert.equal(manualClosed.pendingParts, 1);
  assert.equal((await stock('99012001')).onHand, 0);
  assert.equal((await stock('99012002')).onHand, 0);
  assert.equal((await stock('99012003')).inTransit, 1);
  const manualReceipts = await deliveryCount();
  await warehouse.closeCustomerDeliveryRun(manualScoped.id, manualCloseBody, tech);
  assert.equal(await deliveryCount(), manualReceipts);
  await assert.rejects(() => manual({ runId: manualScanned.id }), statusCode(409));
  console.log('PASS manual recording rejects ambiguous legacy types and physical counts atomically; existing signed close releases exact origins once and preserves pending parts');

  const staleManualPo = await po('990150', [['99015001', 'Fixed Window', 1], ['99015002', 'Fixed Window', 1]]);
  for (const barcode of ['99015001-WINDOW', '99015002-WINDOW'])
    await warehouse.scan({ barcode, action: 'RECEIVE', storeId: store.id, ...request() }, admin);
  const staleManual = await manual({ poKey: `external:${staleManualPo.id}` });
  await warehouse.scan({ barcode: '99015001-WINDOW', action: 'RELEASE', storeId: store.id, ...request() }, admin);
  const staleIdentity = { ...request(), runId: staleManual.id, poKey: `external:${staleManualPo.id}` };
  await assert.rejects(() => manual(staleIdentity), statusCode(400));
  assert.equal(await db.warehouseCustomerDeliveryRunEvent.count({ where: { requestKey: staleIdentity.requestKey } }), 0);
  assert.equal((await read(staleManual.id)).totalParts, 2, 'Stale allocations are reported, never silently discarded');
  const oversizedManualPo = await po('990160', Array.from({ length: 501 }, (_, index) => [`9916${String(index).padStart(4, '0')}`, 'Fixed Window', 1]));
  await db.warehouseStock.updateMany({ where: { unit: { externalPoId: oversizedManualPo.id } }, data: { onHand: 1, unassigned: 1 } });
  const oversizedIdentity = { ...request(), poKey: `external:${oversizedManualPo.id}` };
  await assert.rejects(() => manual(oversizedIdentity), statusCode(400));
  assert.equal(await db.warehouseCustomerDeliveryRun.count({ where: { requestKey: oversizedIdentity.requestKey } }), 0);
  console.log('PASS manual additions reject stale zero-stock allocations and oversized POs without truncation or partial saves');

  const releasePo = await po('990170', [
    ['99017001', 'French Door panels: 2', 3], ['99017002', 'Fixed Window', 2], ['99017003', 'Pending Window', 1],
  ]);
  const releaseKey = `external:${releasePo.id}`;
  await db.order.update({ where: { id: 950000 }, data: { poNumber: '990170' } });
  await db.warehouseStock.update({ where: { lineNumber: '99017002' }, data: { onHand: 1, unassigned: 1 } });
  for (const [barcode, storeId] of [
    ['99017001-DOOR', store.id], ['99017001-FRAME', store.id], ['99017001-DOOR', otherStore.id], ['99017002-WINDOW', otherStore.id],
  ]) await warehouse.scan({ barcode, action: 'RECEIVE', storeId, ...request() }, admin);
  await db.warehouseStock.update({ where: { lineNumber: '99017003' }, data: { inTransit: 1 } });
  for (const actor of [admin, operator, tech]) {
    const options = await warehouse.warehousePoReleaseOptions({ poKey: releaseKey, storeId: 'all' }, actor);
    assert.equal(options.group.key, releaseKey);
    assert.equal(options.group.units.length, 2, 'Only exact-PO warehouse stock is available for release');
    assert.equal(options.activeCountId, null);
    if (actor === tech) assert(options.group.units.every(unit => unit.pieceId === undefined));
  }
  const scopedReleaseOptions = await warehouse.warehousePoReleaseOptions({ poKey: releaseKey, storeId: String(store.id) }, tech);
  assert.equal(scopedReleaseOptions.group.units.length, 1);
  assert.equal(scopedReleaseOptions.group.units[0].onHand, 2);
  assert(scopedReleaseOptions.group.units[0].stores.every(location => location.id === store.id));
  assert.equal(scopedReleaseOptions.group.units[0].unassigned, 0);
  const unassignedReleaseOptions = await warehouse.warehousePoReleaseOptions({ poKey: releaseKey, storeId: 'unassigned' }, operator);
  assert.equal(unassignedReleaseOptions.group.units.length, 1);
  assert.equal(unassignedReleaseOptions.group.units[0].onHand, 1);
  assert.deepEqual(unassignedReleaseOptions.group.units[0].stores, []);
  assert.equal(unassignedReleaseOptions.group.units[0].partTracking.onHand.UNKNOWN, 1);
  await assert.rejects(() => warehouse.warehousePoReleaseOptions({ poKey: `external:${oversizedManualPo.id}` }, admin), statusCode(400));
  await assert.rejects(() => warehouse.warehousePoReleaseOptions({ poKey: releaseKey, storeId: '0' }, admin), statusCode(400));
  await assert.rejects(() => warehouse.warehousePoReleaseOptions({ poKey: releaseKey }, { id: admin.id, role: { name: 'client' } }), statusCode(403));
  const doorReleaseVersion = (await stock('99017001')).version, windowReleaseVersion = (await stock('99017002')).version;
  const releaseBody = { ...request(), poKey: releaseKey, items: [
    { barcode: '99017001', storeId: store.id, quantity: 2, parts: { DOOR: 1, FRAME: 1 }, version: doorReleaseVersion },
    { barcode: '99017001', storeId: otherStore.id, quantity: 1, parts: { DOOR: 1 }, version: doorReleaseVersion },
    { barcode: '99017002', storeId: otherStore.id, quantity: 1, parts: { WINDOW: 1 }, version: windowReleaseVersion },
    { barcode: '99017002', storeId: null, quantity: 1, parts: { UNKNOWN: 1 }, version: windowReleaseVersion },
  ] };
  const beforePoRelease = await immutableInventory();
  const releaseRunCount = await db.warehouseCustomerDeliveryRun.count();
  for (const [changes, expected] of [
    [{ poKey: 'order:950000' }, 400],
    [{ items: [...releaseBody.items, releaseBody.items[0]] }, 400],
    [{ items: releaseBody.items.map((item, index) => index === 1 ? { ...item, version: item.version + 1 } : item) }, 400],
    [{ items: releaseBody.items.map(item => ({ ...item, version: item.version + 1 })) }, 409],
    [{ items: releaseBody.items.map((item, index) => index === 0 ? { ...item, quantity: 3, parts: { DOOR: 2, FRAME: 1 } } : item) }, 400],
    [{ items: releaseBody.items.map((item, index) => index === 0 ? { ...item, parts: { WINDOW: 2 } } : item) }, 400],
    [{ items: [...releaseBody.items, { barcode: '99017003', storeId: store.id, quantity: 1, parts: { WINDOW: 1 }, version: 0 }] }, 400],
  ]) await assert.rejects(() => warehouse.releaseWarehousePo({ ...releaseBody, ...request(), ...changes }, operator), statusCode(expected));
  const releaseCount = await db.warehouseCount.create({ data: { ...request(), activeSlot: 1, startedById: admin.id } });
  assert.equal((await warehouse.warehousePoReleaseOptions({ poKey: releaseKey }, admin)).activeCountId, releaseCount.id);
  await assert.rejects(() => warehouse.releaseWarehousePo(releaseBody, operator), statusCode(409));
  await db.warehouseCount.update({ where: { id: releaseCount.id }, data: { activeSlot: null } });
  assert.deepEqual(await immutableInventory(), beforePoRelease, 'Invalid selections cannot partially move stock');
  const releaseRace = await Promise.all([
    warehouse.releaseWarehousePo(releaseBody, operator),
    warehouse.releaseWarehousePo({ ...releaseBody, items: [...releaseBody.items].reverse() }, operator),
  ]);
  assert.equal(releaseRace.filter(result => result.replayed).length, 1);
  const releaseResult = releaseRace.find(result => !result.replayed);
  assert.equal(releaseResult.units, 2);
  assert.equal(releaseResult.parts, 5);
  assert.deepEqual(releaseResult.stores.map(location => [location.storeId, location.parts]).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)), [[null, 1], [store.id, 2], [otherStore.id, 2]]);
  assert.equal((await stock('99017001')).onHand, 0);
  assert.equal((await stock('99017001')).released, 3);
  assert.equal((await stock('99017001')).version, doorReleaseVersion + 2, 'Each source allocation must reload the updated stock before moving');
  assert.equal((await stock('99017002')).version, windowReleaseVersion + 2);
  assert.equal((await stock('99017003')).inTransit, 1);
  assert.equal(await deliveryCount(), beforePoRelease.receipts, 'Installation release must not create a signed customer receipt');
  assert.equal(await db.warehouseCustomerDeliveryRun.count(), releaseRunCount, 'Installation release must not create a customer delivery');
  assert.equal(await db.warehouseMovement.count(), beforePoRelease.movements + 4);
  const releaseMovements = await db.warehouseMovement.findMany({ where: { lineNumber: { in: ['99017001', '99017002'] }, type: 'RELEASE' } });
  assert.equal(new Set(releaseMovements.map(movement => movement.requestKey)).size, 4, 'Same-piece source movements require distinct deterministic keys');
  assert(releaseMovements.every(movement => movement.customerDeliveryId === null && movement.actorId === operator.id));
  await db.warehouseStore.update({ where: { id: store.id }, data: { name: 'Synthetic renamed after release' } });
  await db.warehouseCount.update({ where: { id: releaseCount.id }, data: { activeSlot: 1 } });
  assert.deepEqual(await warehouse.releaseWarehousePo(releaseBody, operator), { ...releaseResult, replayed: true }, 'Replay must preserve original source names and bypass later count/version changes');
  await db.warehouseCount.update({ where: { id: releaseCount.id }, data: { activeSlot: null } });
  await assert.rejects(() => warehouse.releaseWarehousePo(releaseBody, admin), statusCode(409));
  await assert.rejects(() => warehouse.releaseWarehousePo({ ...releaseBody, poKey: 'order:950000' }, operator), statusCode(409));
  await assert.rejects(() => warehouse.releaseWarehousePo({ ...releaseBody, items: releaseBody.items.map((item, index) => index === 0 ? { ...item, storeId: 99999 } : item) }, operator), statusCode(409));
  const afterPoRelease = await immutableInventory();
  await assert.rejects(() => warehouse.releaseWarehousePo({ ...releaseBody, ...request() }, tech), statusCode(409));
  assert.deepEqual(await immutableInventory(), afterPoRelease);
  console.log('PASS exact-PO installation release reviews scoped full stock, preserves role projections, validates combined origins and versions, releases atomically unsigned, and replays once with stable source provenance');

  const legacyReleasePo = await po('990180', [['99018001', 'French Door panels: 2', 3]]);
  await db.warehouseStock.update({ where: { lineNumber: '99018001' }, data: { onHand: 3, unassigned: 1 } });
  await db.warehouseStoreStock.createMany({ data: [
    { lineNumber: '99018001', storeId: store.id, onHand: 1 },
    { lineNumber: '99018001', storeId: otherStore.id, onHand: 1 },
  ] });
  const beforeLegacyRelease = await immutableInventory();
  await assert.rejects(() => warehouse.releaseWarehousePo({ ...request(), poKey: `external:${legacyReleasePo.id}`, items: [
    { barcode: '99018001', quantity: 1, parts: { FRAME: 1 }, storeId: store.id, version: 0 },
    { barcode: '99018001', quantity: 1, parts: { FRAME: 1 }, storeId: otherStore.id, version: 0 },
  ] }, tech), statusCode(400));
  assert.deepEqual(await immutableInventory(), beforeLegacyRelease, 'Legacy UNKNOWN pools at different origins must not become too many frames');
  const legacyRelease = await warehouse.releaseWarehousePo({ ...request(), poKey: `external:${legacyReleasePo.id}`, items:
    [null, store.id, otherStore.id].map(storeId => ({ barcode: '99018001', quantity: 1, parts: { UNKNOWN: 1 }, storeId, version: 0 })),
  }, tech);
  assert.equal(legacyRelease.parts, 3);
  const legacyReleased = await stock('99018001');
  assert.equal(legacyReleased.onHand, 0);
  assert.equal(legacyReleased.partBalances.balances.UNKNOWN.released, 3, 'Unsigned manual release preserves explicitly unclassified quantities without inventing types');
  console.log('PASS combined legacy type limits hold across locations and authorized technicians can release explicit unclassified quantities');
}

main().catch(error => {
  console.error(error.stderr?.toString() || error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (db) await db.$disconnect();
  if (created) {
    sql(`DROP DATABASE \`${database}\``, false);
    console.log('Disposable database removed; application data was not changed.');
  }
});
