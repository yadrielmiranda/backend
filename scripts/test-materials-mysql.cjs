// Runs only against a new, disposable local MySQL database; Stripe is an in-memory fake.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const envLine = fs.readFileSync('.env', 'utf8').match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
const configured = process.env.DATABASE_URL || envLine?.[1].trim().replace(/^['"]|['"]$/g, '');
const url = new URL(configured);
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Local MySQL only.');
const database = `impact_materials_check_${Date.now()}_${randomUUID().slice(0, 8)}`;
assert(/^impact_materials_check_\d+_[a-f0-9]{8}$/.test(database));
const mysql = process.env.MYSQL_BIN || 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe';
const args = ['--protocol=tcp', '--host=127.0.0.1', `--port=${url.port || 3306}`, `--user=${decodeURIComponent(url.username)}`, '--default-character-set=utf8mb4', '--batch'];
function sql(value, useDatabase = true) {
  return execFileSync(mysql, [...args, ...(useDatabase ? [`--database=${database}`] : [])], {
    input: value, encoding: 'utf8', env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) }, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
const request = () => ({ requestKey: randomUUID() });
let created = false, db;
async function main() {
  sql(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`, false);
  created = true;
  const migrations = fs.readdirSync('prisma/migrations', { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  assert(migrations.includes('20261012170000_materials_inventory_sales'));
  sql(migrations.map(name => fs.readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8')).join('\n'));
  console.log('PASS full migration history and new material tables apply on MySQL');
  url.pathname = `/${database}`;
  process.env.DATABASE_URL = url.toString();
  process.env.TS_NODE_PROJECT = path.join(root, 'tsconfig.json');
  require('ts-node/register/transpile-only');
  require('tsconfig-paths/register');
  const { PrismaClient } = require('@prisma/client');
  const { MaterialsInventoryService } = require('../src/materials/materials-inventory.service');
  const { MaterialsStoreInventoryService } = require('../src/materials/materials-store-inventory.service');
  const { MaterialsStoreIssueService } = require('../src/materials/materials-store-issue.service');
  const { MaterialsSalesService } = require('../src/materials/materials-sales.service');
  const { NotificationsService } = require('../src/notifications/notifications.service');
  const { NotificationEmailService } = require('../src/notifications/notification-email.service');
  const { NotificationSmsService } = require('../src/notifications/notification-sms.service');
  const { MaterialSaleEmailService } = require('../src/materials/material-sale-email.service');
  const { WarehouseService } = require('../src/warehouse/warehouse.service');
  db = new PrismaClient({ datasourceUrl: url.toString() });
  const role = await db.role.upsert({ where: { name: 'admin' }, create: { name: 'admin' }, update: {} });
  const user = await db.user.create({ data: { username: 'materials-check', firstName: 'Materials', lastName: 'Check', email: 'buyer-admin@example.test', password: 'not-a-login', idRole: role.id } });
  const secondAdmin = await db.user.create({ data: { username: 'materials-admin-2', firstName: 'Second', lastName: 'Admin', email: 'admin2@example.test', password: 'not-a-login', idRole: role.id } });
  await db.user.create({ data: { username: 'materials-inactive-admin', firstName: 'Inactive', lastName: 'Admin', email: 'inactive@example.test', password: 'not-a-login', idRole: role.id, isActive: false } });
  await db.user.create({ data: { username: 'materials-deleted-admin', firstName: 'Deleted', lastName: 'Admin', email: 'deleted@example.test', password: 'not-a-login', idRole: role.id, deletedAt: new Date() } });
  const admin = { id: user.id, role: { name: 'admin' } };
  const operator = { id: user.id, role: { name: 'operator' } };
  const clientRole = await db.role.upsert({ where: { name: 'client' }, create: { name: 'client' }, update: {} });
  const onlineBuyer = await db.user.create({ data: { username: 'online-buyer', firstName: 'Online', lastName: 'Buyer', email: 'online-buyer@example.test', password: 'not-a-login', idRole: clientRole.id } });
  const customer = { id: onlineBuyer.id, role: { name: 'client' } };
  const warehouse = new WarehouseService(db);
  const inventory = new MaterialsInventoryService(db);
  const mailValues = { NOTIFICATIONS_SMTP_HOST: 'smtp.example.test', NOTIFICATIONS_SMTP_USER: 'notifications@example.test', NOTIFICATIONS_SMTP_PASS: 'fake-secret', NOTIFICATIONS_SMTP_FROM_EMAIL: 'notifications@example.test', PUBLIC_FRONTEND_URL: 'https://portal.example.test' };
  const mailConfig = { get: key => mailValues[key] };
  // Enqueue only: no SMTP worker, sockets, timers or external send is started by this script.
  const emailService = new NotificationEmailService(db, mailConfig);
  const notifications = new NotificationsService(db, { sendNotificationToUser: () => {} }, new NotificationSmsService(db, mailConfig, {}), emailService);
  const saleEmails = new MaterialSaleEmailService(db, emailService);
  const sales = new MaterialsSalesService(db, { get: key => key === 'FRONTEND_URL' ? 'http://localhost:3000' : undefined }, inventory, notifications, saleEmails);
  const sessions = new Map(), intents = new Map(), charges = new Map();
  let sessionSequence = 0;
  sales.stripeClient = {
    checkout: { sessions: {
      create: async (input, opts) => {
        const old = [...sessions.values()].find(s => s.idempotencyKey === opts.idempotencyKey);
        if (old) return old;
        const id = `cs_test_material_${++sessionSequence}`;
        const s = { id, object: 'checkout.session', mode: 'payment', metadata: input.metadata, currency: input.line_items[0].price_data.currency,
          amount_total: input.line_items[0].price_data.unit_amount, status: 'open', payment_status: 'unpaid', payment_intent: null,
          url: `https://checkout.stripe.test/${id}`, expires_at: input.expires_at, idempotencyKey: opts.idempotencyKey };
        sessions.set(id, s); return s;
      },
      retrieve: async id => { assert(sessions.has(id)); return sessions.get(id); },
      expire: async id => { const s = sessions.get(id); assert.equal(s.status, 'open'); s.status = 'expired'; s.url = null; return s; },
      list: async ({ payment_intent }) => ({ data: [...sessions.values()].filter(s => s.payment_intent === payment_intent) }),
    } },
    paymentIntents: { retrieve: async id => { assert(intents.has(id)); return intents.get(id); } },
    charges: { retrieve: async id => { assert(charges.has(id)); return charges.get(id); } },
  };
  const paySession = async id => {
    const s = sessions.get(id);
    const intentId = `pi_${id}`, chargeId = `ch_${id}`;
    s.status = 'complete'; s.payment_status = 'paid'; s.payment_intent = intentId;
    charges.set(chargeId, { id: chargeId, object: 'charge', currency: s.currency, amount: s.amount_total, amount_captured: s.amount_total,
      amount_refunded: 0, paid: true, captured: true, payment_intent: intentId, metadata: s.metadata });
    intents.set(intentId, { id: intentId, status: 'succeeded', metadata: s.metadata, latest_charge: chargeId });
    await sales.handleVerifiedStripeEvent({ type: 'checkout.session.completed', data: { object: { id, metadata: s.metadata } } });
    return { s, charge: charges.get(chargeId) };
  };
  await db.globalParameter.upsert({ where: { key: 'SALES_TAX' }, create: { key: 'SALES_TAX', value: '0.07' }, update: { value: '0.07' } });
  const storeA = await warehouse.createStore({ name: 'Materials check A' }, admin);
  const storeB = await warehouse.createStore({ name: 'Materials check B' }, admin);
  const tube = await inventory.createUnit({ ...request(), name: 'Tube' }, admin);
  const box = await inventory.createUnit({ ...request(), name: 'Box' }, admin);
  const bag = await inventory.createUnit({ ...request(), name: 'Bag' }, admin);
  let product = await inventory.createProduct({ ...request(), name: 'Synthetic manual caulking', baseUnitId: tube.id,
    purchaseUnitId: box.id, purchaseMultiplier: 12, purchaseBarcode: '10035777434649' }, admin);
  assert.equal(product.totalBaseQuantity, 0);
  assert.equal(product.isSaleEnabled, false);
  const base = product.presentations.find(p => p.isBase), carton = product.presentations.find(p => p.isPurchase);
  assert.equal(base.barcode, null);
  assert.equal(carton.multiplier, 12);
  const receipt = { ...request(), productId: product.id, presentationId: carton.id, storeId: storeA.id, quantity: 3, costPerPackage: 24, reference: 'SYNTHETIC-ONLY' };
  await inventory.receive(receipt, admin);
  await inventory.receive(receipt, admin);
  assert.equal((await inventory.product(product.id, admin)).totalBaseQuantity, 36);
  await assert.rejects(() => inventory.receive({ ...receipt, quantity: 4 }, admin), /already used/i);
  await inventory.receive({ ...receipt, ...request(), storeId: storeB.id, quantity: 2, costPerPackage: 26 }, admin);
  assert.equal((await inventory.product(product.id, admin)).totalBaseQuantity, 60);
  await assert.rejects(() => warehouse.updateStore(storeA.id, { name: storeA.name, version: storeA.version, isActive: false }, admin), /materials/i);
  await inventory.internalUse({ ...request(), productId: product.id, presentationId: base.id, storeId: storeA.id, quantity: 4, recipient: 'Synthetic crew', note: 'Integration check' }, operator);
  let state = await inventory.product(product.id, admin);
  let local = state.inventoryByStore.find(s => s.store.id === storeA.id);
  assert.equal(local.presentations.find(p => p.id === base.id).quantity, 8);
  assert.equal(local.presentations.find(p => p.id === carton.id).quantity, 2);
  assert.equal(state.totalBaseQuantity, 56);
  console.log('PASS zero stock, optional barcode, per-entry costs, receipt idempotency and automatic opening for internal use');
  state = await inventory.createPresentation(product.id, { ...request(), unitId: bag.id, multiplier: 6, generateBarcode: true, salePrice: 10, isSaleEnabled: true }, admin);
  const bagPack = state.presentations.find(p => p.unitId === bag.id);
  assert(bagPack.barcode?.startsWith('MAT-'));
  await inventory.repack({ ...request(), productId: product.id, presentationId: bagPack.id, storeId: storeA.id, quantity: 1, action: 'PACK' }, admin);
  assert.equal((await inventory.product(product.id, admin)).totalBaseQuantity, 56);
  for (const [id, price] of [[base.id, 2], [carton.id, 20]]) {
    const p = (await inventory.product(product.id, admin)).presentations.find(p => p.id === id);
    await inventory.updatePresentation(id, { ...request(), version: p.version, salePrice: price, isSaleEnabled: true }, admin);
  }
  state = await inventory.product(product.id, admin);
  await inventory.updateProduct(product.id, { ...request(), version: state.version, isSaleEnabled: true }, admin);
  const draft = await sales.create({ ...request(), storeId: storeA.id, customerName: 'Synthetic buyer', lines: [{ presentationId: base.id, quantity: 5 }, { presentationId: carton.id, quantity: 1 }] }, admin);
  assert.equal(draft.subtotal, '30.00'); assert.equal(draft.taxAmount, '2.10'); assert.equal(draft.total, '32.10');
  await sales.confirm(draft.id, admin);
  state = await inventory.product(product.id, admin);
  assert.equal(state.reservedBaseQuantity, 17);
  await assert.rejects(() => inventory.internalUse({ ...request(), productId: product.id, presentationId: base.id, storeId: storeA.id, quantity: 16, recipient: 'Crew', note: 'Must not consume reserved' }, admin), /Insufficient|reserved/i);
  await assert.rejects(() => sales.deliver(draft.id, randomUUID(), admin), /paid|payment|balance/i);
  await sales.recordPayment(draft.id, { ...request(), paymentMethod: 'CASH', amount: 10, fundsVerified: true }, admin);
  assert.equal(await db.notification.count(), 0);
  await assert.rejects(() => sales.deliver(draft.id, randomUUID(), admin), /paid|payment|balance/i);
  const sendToRoles = notifications.createAndSendToRoles.bind(notifications);
  notifications.createAndSendToRoles = async (...args) => { await sendToRoles(...args); throw new Error('Synthetic queue failure'); };
  await assert.rejects(() => sales.recordPayment(draft.id, { ...request(), paymentMethod: 'CASH', amount: 22.10, fundsVerified: true }, admin), /Synthetic queue failure/);
  assert.equal((await db.materialSale.findUnique({ where: { id: draft.id } })).paidAmount.toFixed(2), '10.00');
  assert.equal(await db.notification.count(), 0); assert.equal(await db.notificationEmail.count(), 0);
  assert.equal(await db.materialOperation.count({ where: { requestKey: `material-sale-paid:${draft.id}` } }), 0);
  notifications.createAndSendToRoles = sendToRoles;
  await sales.recordPayment(draft.id, { ...request(), paymentMethod: 'CASH', amount: 22.10, fundsVerified: true }, admin);
  const manualAlerts = await db.notification.findMany({ where: { dedupeKey: `material-sale:${draft.id}:paid` }, orderBy: { recipientId: 'asc' } });
  assert.deepEqual(manualAlerts.map(n => n.recipientId), [user.id, secondAdmin.id]);
  assert.equal(await db.notificationEmail.count(), 2); assert.equal(await db.notificationSms.count(), 0);
  console.log('PASS full-payment bell/email outbox for active admins only and atomic rollback with payment; no real sends');
  const deliveryKey = randomUUID();
  await sales.deliver(draft.id, deliveryKey, admin);
  await sales.deliver(draft.id, deliveryKey, admin);
  state = await inventory.product(product.id, admin);
  assert.equal(state.totalBaseQuantity, 39); assert.equal(state.reservedBaseQuantity, 0);
  assert.equal(await db.order.count(), 0); assert.equal(await db.payment.count(), 0);
  console.log('PASS custom repacking, snapshot prices/tax, reservations, partial payments and one physical delivery without commercial-order side effects');
  const catalog = await sales.customerCatalog(admin);
  assert.equal(catalog.products[0].presentations.find(p => p.id === base.id).availableQuantity, 39);
  assert(!JSON.stringify(catalog).includes('costPerPackage'));
  const onlineRequest = { ...request(), lines: [{ presentationId: base.id, quantity: 30 }] };
  const saleCountBeforeStaffCheckout = await db.materialSale.count();
  for (const staff of [admin, operator]) await assert.rejects(() => sales.createCustomerOrder(onlineRequest, staff), /select a customer/i);
  assert.equal(await db.materialSale.count(), saleCountBeforeStaffCheckout);
  const online = await sales.createCustomerOrder(onlineRequest, customer);
  assert.equal(online.customerName, 'Online Buyer');
  assert.equal((await db.materialSale.findUnique({ where: { id: online.id } })).createdById, customer.id);
  assert.equal((await db.materialSale.findUnique({ where: { id: online.id } })).customerUserId, customer.id);
  await db.user.update({ where: { id: customer.id }, data: { firstName: 'Updated' } });
  const retriedOnline = await sales.createCustomerOrder(onlineRequest, customer);
  assert.equal(retriedOnline.id, online.id); assert.equal(retriedOnline.customerName, 'Online Buyer'); assert.equal(retriedOnline.replayed, true);
  // Exercise the exact migration UPDATE with populated legacy rows, after simulating
  // the nullable-column state that existed immediately before its backfill runs.
  await db.materialSale.updateMany({ where: { id: { in: [online.id, draft.id] } }, data: { customerUserId: null } });
  const customerMigration = fs.readFileSync('prisma/migrations/20261012230000_material_sale_customers/migration.sql', 'utf8');
  const backfill = customerMigration.match(/UPDATE `material_sales` s[\s\S]*?;/)?.[0];
  assert(backfill, 'Customer migration backfill must exist.');
  sql(backfill);
  assert.equal((await db.materialSale.findUnique({ where: { id: online.id } })).customerUserId, customer.id);
  assert.equal((await db.materialSale.findUnique({ where: { id: draft.id } })).customerUserId, null);
  console.log('PASS populated migration backfill links proven online buyers only, never manual sale creators');
  const allocated = await db.materialSaleLine.findMany({ where: { saleId: online.id } });
  assert.equal(new Set(allocated.map(l => l.storeId)).size, 2);
  const token = new URL(online.publicUrl).pathname.split('/').pop();
  const checkout = await sales.checkoutForPublic(token);
  assert.equal((await sales.checkoutForPublic(token)).sessionId, checkout.sessionId);
  const paid = await paySession(checkout.sessionId);
  const purchaseAlerts = await db.notification.findMany({ where: { dedupeKey: { startsWith: `material-sale:${online.id}:paid` } }, orderBy: { recipientId: 'asc' } });
  assert.equal(purchaseAlerts.length, 3);
  assert.equal(purchaseAlerts[0].recipientId, user.id); assert.equal(purchaseAlerts[0].dedupeKey, `material-sale:${online.id}:paid`);
  assert.equal(purchaseAlerts[1].recipientId, secondAdmin.id); assert.equal(purchaseAlerts[1].dedupeKey, `material-sale:${online.id}:paid`);
  assert.equal(purchaseAlerts[2].recipientId, customer.id); assert.equal(purchaseAlerts[2].dedupeKey, `material-sale:${online.id}:paid:customer`);
  assert.equal(await db.notificationEmail.count(), 5); assert.equal(await db.notificationSms.count(), 0);
  const myOrders = await sales.listCustomerOrders(customer, { page: '1', pageSize: '20' });
  assert.equal(myOrders.total, 1); assert.equal(myOrders.items[0].id, online.id); assert.equal(myOrders.items[0].paymentStatus, 'PAID');
  assert(!myOrders.items.some(s => s.id === draft.id));
  assert.equal((await sales.listCustomerOrders({ ...admin, id: secondAdmin.id })).total, 0);
  assert.equal((await sales.list(admin, { q: draft.code }))[0].id, draft.id);
  console.log('PASS staff self-checkout rejected, customer paid order history/email, admin alerts and full-DB pickup search');
  await sales.handleVerifiedStripeEvent({ type: 'checkout.session.expired', data: { object: { id: checkout.sessionId, metadata: paid.s.metadata } } });
  assert.equal((await sales.getPublic(token)).paymentStatus, 'PAID');
  await sales.deliver(online.id, randomUUID(), admin);
  assert.equal((await inventory.product(product.id, admin)).totalBaseQuantity, 9);
  const publicView = await sales.getPublic(token);
  assert(!('publicToken' in publicView)); assert(!('store' in publicView)); assert(!JSON.stringify(publicView).includes('costPerPackage'));
  console.log('PASS public quantities inside closed boxes, multi-store allocation, Stripe idempotency/late events, privacy and auto-opening delivery');
  const competing = await Promise.allSettled([1, 2].map(() => sales.createCustomerOrder({ ...request(), lines: [{ presentationId: base.id, quantity: 6 }] }, customer)));
  assert.equal(competing.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(competing.filter(r => r.status === 'rejected').length, 1);
  const held = competing.find(r => r.status === 'fulfilled').value;
  await db.materialSale.update({ where: { id: held.id }, data: { expiresAt: new Date(Date.now() - 60000) } });
  await sales.expireUnpaidOnlineOrders();
  assert.equal((await db.materialSale.findUnique({ where: { id: held.id } })).status, 'CANCELED');
  assert.equal((await inventory.product(product.id, admin)).availableBaseQuantity, 9);
  await assert.rejects(() => inventory.createUnit({ ...request(), name: 'Forbidden' }, operator), /authorized|administrator/i);
  await assert.rejects(() => sales.recordPayment(draft.id, { ...request(), amount: 1, paymentMethod: 'CASH', fundsVerified: true }, operator), /administrator/i);
  console.log('PASS concurrent oversell protection, abandoned public reservation expiry and role restrictions');

  const cancelable = await sales.createCustomerOrder({ ...request(), lines: [{ presentationId: base.id, quantity: 3 }] }, customer);
  const cancelToken = new URL(cancelable.publicUrl).pathname.split('/').pop();
  const cancelCheckout = await sales.checkoutForPublic(cancelToken);
  const beforeCancel = await inventory.product(product.id, admin);
  assert.equal(beforeCancel.availableBaseQuantity, 6);
  assert.equal(beforeCancel.reservedBaseQuantity, 3);
  assert.equal((await sales.getCustomerOrder(cancelable.id, customer)).canCancel, true);
  await assert.rejects(() => sales.getCustomerOrder(cancelable.id, { ...admin, id: admin.id + 999 }), /not found/i);
  await assert.rejects(() => sales.cancelCustomerOrder(cancelable.id, { ...admin, id: admin.id + 999 }), /not found/i);
  assert.equal(sessions.get(cancelCheckout.sessionId).status, 'open');
  const canceled = await sales.cancelCustomerOrder(cancelable.id, customer);
  assert.equal(canceled.status, 'CANCELED'); assert.equal(canceled.canCancel, false);
  assert.equal(sessions.get(cancelCheckout.sessionId).status, 'expired');
  assert.deepEqual(await sales.cancelCustomerOrder(cancelable.id, customer), canceled);
  const afterCancel = await inventory.product(product.id, admin);
  assert.equal(afterCancel.totalBaseQuantity, beforeCancel.totalBaseQuantity);
  assert.equal(afterCancel.availableBaseQuantity, 9); assert.equal(afterCancel.reservedBaseQuantity, 0);
  assert.equal(await db.eventLog.count({ where: { entityType: 'MaterialSale', entityId: cancelable.id, message: { startsWith: 'Customer canceled' } } }), 1);
  await assert.rejects(() => sales.checkoutForPublic(cancelToken), /not available for payment/i);
  console.log('PASS owned customer cancellation expires Stripe first, releases reservations once and preserves physical stock');

  const directBuyer = await db.user.create({ data: { username: 'direct-buyer', firstName: 'Direct', lastName: 'Buyer', email: 'direct-buyer@example.test', phone: '555-0199', password: 'not-a-login', idRole: clientRole.id } });
  const buyerActor = { id: directBuyer.id, role: { name: 'client' } };
  const matches = await sales.searchCustomers(admin, { q: 'Direct Buyer' });
  assert.deepEqual(matches, [{ id: directBuyer.id, name: 'Direct Buyer', email: 'direct-buyer@example.test', phone: '555-0199' }]);
  assert.equal((await sales.searchCustomers(operator, { q: 'inactive' })).length, 0);
  assert.equal((await sales.searchCustomers(operator, { q: 'deleted' })).length, 0);
  await assert.rejects(() => sales.searchCustomers(buyerActor, { q: 'Direct' }), /warehouse staff/i);
  await inventory.receive({ ...request(), productId: product.id, presentationId: carton.id, storeId: storeA.id, quantity: 1, costPerPackage: 24 }, admin);
  const directRequest = { ...request(), storeId: storeA.id, customerUserId: directBuyer.id, lines: [{ presentationId: base.id, quantity: 2 }] };
  const linked = await sales.create(directRequest, operator);
  const linkedRow = await db.materialSale.findUnique({ where: { id: linked.id } });
  assert.equal(linkedRow.createdById, operator.id); assert.equal(linkedRow.customerUserId, directBuyer.id);
  assert.equal((await sales.listCustomerOrders(buyerActor)).total, 0);
  await assert.rejects(() => sales.getCustomerOrder(linked.id, buyerActor), /not found/i);
  await assert.rejects(() => sales.getPublic(linked.publicToken), /not found/i);
  await db.user.update({ where: { id: directBuyer.id }, data: { firstName: 'Changed' } });
  assert.equal((await sales.create(directRequest, operator)).customerName, 'Direct Buyer');
  await assert.rejects(() => sales.create({ ...directRequest, customerUserId: secondAdmin.id }, operator), /already used/i);
  await sales.confirm(linked.id, operator);
  assert.equal((await sales.getCustomerOrder(linked.id, buyerActor)).canCancel, false);
  assert.equal((await sales.listCustomerOrders(buyerActor)).items[0].id, linked.id);
  await assert.rejects(() => sales.getCustomerOrder(linked.id, admin), /not found/i);
  await assert.rejects(() => sales.cancelCustomerOrder(linked.id, buyerActor), /cannot be canceled online/i);
  await sales.recordPayment(linked.id, { ...request(), amount: Number(linked.total), paymentMethod: 'CASH', fundsVerified: true }, admin);
  const linkedBuyerNotice = await db.notification.findFirst({ where: { dedupeKey: `material-sale:${linked.id}:paid:customer` } });
  assert.equal(linkedBuyerNotice.recipientId, directBuyer.id);
  assert.equal(await db.materialSaleEmail.count({ where: { saleId: linked.id } }), 0);
  assert(!(await sales.listCustomerOrders(admin)).items.some(order => order.id === linked.id));
  console.log('PASS direct registered buyer identity, private drafts, durable history, staff separation and invoice email');

  const guest = await sales.create({ ...request(), storeId: storeA.id, customerName: 'Manual guest', customerEmail: directBuyer.email, lines: [{ presentationId: base.id, quantity: 1 }] }, admin);
  assert.equal(guest.customerUserId, null);
  assert.equal(await db.user.count({ where: { email: directBuyer.email } }), 1);
  await sales.confirm(guest.id, admin);
  await assert.rejects(() => sales.getCustomerOrder(guest.id, buyerActor), /not found/i);
  const guestPay = { ...request(), amount: Number(guest.total), paymentMethod: 'CASH', fundsVerified: true };
  const enqueueGuest = saleEmails.enqueue.bind(saleEmails);
  saleEmails.enqueue = async (...args) => { await enqueueGuest(...args); throw new Error('Synthetic guest outbox failure'); };
  await assert.rejects(() => sales.recordPayment(guest.id, guestPay, admin), /Synthetic guest outbox failure/);
  assert.equal((await db.materialSale.findUnique({ where: { id: guest.id } })).paidAmount.toFixed(2), '0.00');
  assert.equal(await db.materialSaleEmail.count({ where: { saleId: guest.id } }), 0);
  assert.equal(await db.notification.count({ where: { dedupeKey: `material-sale:${guest.id}:paid` } }), 0);
  assert.equal(await db.materialOperation.count({ where: { requestKey: `material-sale-paid:${guest.id}` } }), 0);
  saleEmails.enqueue = enqueueGuest;
  await sales.recordPayment(guest.id, guestPay, admin);
  await sales.recordPayment(guest.id, guestPay, admin);
  const guestReceipt = await db.materialSaleEmail.findUnique({ where: { saleId: guest.id } });
  assert.equal(guestReceipt.status, 'PENDING'); assert.equal(guestReceipt.email, directBuyer.email);
  assert.equal(guestReceipt.publicToken, guest.publicToken); assert.equal(guestReceipt.total.toFixed(2), guest.total);
  assert.equal(await db.materialSaleEmail.count({ where: { saleId: guest.id } }), 1);
  assert.equal(await db.notification.count({ where: { dedupeKey: `material-sale:${guest.id}:paid:customer` } }), 0);
  assert(!(await sales.listCustomerOrders(buyerActor)).items.some(order => order.id === guest.id));
  const noEmail = await sales.create({ ...request(), storeId: storeA.id, customerName: 'No email', lines: [{ presentationId: base.id, quantity: 1 }] }, admin);
  await sales.confirm(noEmail.id, admin);
  await sales.recordPayment(noEmail.id, { ...request(), amount: Number(noEmail.total), paymentMethod: 'CASH', fundsVerified: true }, admin);
  assert.equal(await db.materialSaleEmail.count({ where: { saleId: noEmail.id } }), 0);
  console.log('PASS guest email outbox is atomic and idempotent, never links matching emails or creates accounts; missing email remains allowed');

  // Catalog scale checks remain entirely inside the disposable database.
  const category = await inventory.createCategory({ ...request(), name: 'Catalog verification' }, admin);
  await db.materialProduct.createMany({ data: Array.from({ length: 200 }, (_, i) => ({
    code: `CAT-${i + 1}`, name: `Catalogue ${String(i + 1).padStart(3, '0')}`, description: i === 199 ? 'Outdoor catalog search target' : null,
    baseUnitId: tube.id, categoryId: category.id, brand: i % 2 ? 'Beta' : 'Alpha', isSaleEnabled: true,
  })) });
  const catalogProducts = await db.materialProduct.findMany({ where: { categoryId: category.id }, orderBy: { id: 'asc' } });
  await db.materialPresentation.createMany({ data: catalogProducts.flatMap(p => [
    { productId: p.id, unitId: tube.id, name: 'Tube', multiplier: 1, isBase: true, isSaleEnabled: true, salePrice: 15 },
    { productId: p.id, unitId: box.id, name: 'Box of 12', multiplier: 12, isBase: false, isSaleEnabled: true, salePrice: 120 },
  ]) });
  const catalogPacks = await db.materialPresentation.findMany({ where: { productId: { in: catalogProducts.map(p => p.id) }, isBase: false }, orderBy: { productId: 'asc' } });
  await db.materialStock.createMany({ data: catalogPacks.filter((_, i) => i % 2 === 0).map(pack => ({ productId: pack.productId, presentationId: pack.id, storeId: storeA.id, quantity: 1 })) });
  const pageOne = await sales.customerCatalog(admin, { q: 'Catalogue' });
  assert.equal(pageOne.total, 200); assert.equal(pageOne.products.length, 24);
  assert.equal(pageOne.products[0].name, 'Catalogue 001');
  assert.equal(pageOne.products[0].presentations[0].availableQuantity, 12);
  assert.equal(pageOne.products[0].presentations[1].unit.name, 'Box');
  assert.equal(pageOne.products[0].category.name, category.name);
  const pageNine = await sales.customerCatalog(admin, { q: 'Catalogue', page: '9' });
  assert.equal(pageNine.products.length, 8); assert.equal(pageNine.products[0].name, 'Catalogue 193');
  const stockPage = await sales.customerCatalog(admin, { q: 'Catalogue', inStock: 'true', pageSize: '100' });
  assert.equal(stockPage.total, 100); assert.equal(stockPage.products.length, 100);
  assert(stockPage.products.every(p => p.brand === 'Alpha'));
  const filtered = await sales.customerCatalog(admin, { categoryId: String(category.id), brand: 'Beta', sort: 'name-desc', pageSize: '3' });
  assert.equal(filtered.total, 100); assert.deepEqual(filtered.products.map(p => p.name), ['Catalogue 200', 'Catalogue 198', 'Catalogue 196']);
  assert.equal((await sales.customerCatalog(admin, { q: 'Outdoor catalog search' })).products[0].name, 'Catalogue 200');
  const lookupIds = [catalogPacks[0].id, catalogPacks[199].id];
  const cartRefresh = await sales.customerCatalog(admin, { presentationIds: lookupIds.join(','), q: 'does not match', page: '99', inStock: 'true' });
  assert.deepEqual(cartRefresh.products.flatMap(p => p.presentations.map(item => item.id)), lookupIds);
  assert.equal(cartRefresh.products[1].presentations[0].availableQuantity, 0);
  await inventory.updateCategory(category.id, { ...request(), isActive: false }, admin);
  assert(!(await sales.customerCatalog(admin)).categories.some(c => c.id === category.id));
  assert.equal((await inventory.categories(admin)).find(c => c.id === category.id).isActive, false);
  console.log('PASS real MySQL 200-product pagination, category/brand/search filters, exact in-stock totals and cross-page cart refresh');

  const storeInventory = new MaterialsStoreInventoryService(db, inventory);
  const countProducts = catalogProducts.slice(0, 4);
  const countBases = await db.materialPresentation.findMany({ where: { productId: { in: countProducts.map(p => p.id) }, isBase: true }, orderBy: { productId: 'asc' } });
  await db.materialStock.createMany({ data: [
    { productId: countProducts[1].id, presentationId: catalogPacks[1].id, storeId: storeA.id, quantity: 2 },
    { productId: countProducts[1].id, presentationId: countBases[1].id, storeId: storeA.id, quantity: 4 },
    { productId: countProducts[2].id, presentationId: catalogPacks[2].id, storeId: storeB.id, quantity: 3 },
  ] });
  await db.materialProduct.update({ where: { id: catalogProducts[199].id }, data: { isSaleEnabled: false } });
  const countBaseline = await storeInventory.getInventory(storeA.id, operator);
  assert.equal(countBaseline.store.id, storeA.id);
  assert.equal(countBaseline.products.filter(p => p.code.startsWith('CAT-')).length, 200);
  assert(countBaseline.products.some(p => p.id === catalogProducts[199].id && p.totalBaseQuantity === 0));
  const baselineProduct = id => countBaseline.products.find(p => p.id === id);
  const physicalQuantity = async (presentationId, storeId = storeA.id) => (await db.materialStock.findUnique({ where: { presentationId_storeId: { presentationId, storeId } } }))?.quantity ?? 0;
  const countEntry = (index, counts) => ({ productId: countProducts[index].id, version: baselineProduct(countProducts[index].id).version, counts });
  assert.equal(baselineProduct(countProducts[0].id).totalBaseQuantity, 12);
  assert.equal(baselineProduct(countProducts[0].id).presentations.find(p => p.isBase).quantity, 0);
  // A new reservation does not increment product.version; commit must still validate its current quantity.
  const countReservation = await sales.create({ ...request(), storeId: storeA.id, customerName: 'Synthetic count reservation', lines: [{ presentationId: countBases[0].id, quantity: 9 }] }, admin);
  await sales.confirm(countReservation.id, admin);
  assert.equal((await db.materialProduct.findUnique({ where: { id: countProducts[0].id } })).version, baselineProduct(countProducts[0].id).version);
  const rejectedCount = { ...request(), note: 'Synthetic reserved-stock rejection', products: [
    countEntry(1, [{ presentationId: catalogPacks[1].id, quantity: 0 }]),
    countEntry(0, [{ presentationId: catalogPacks[0].id, quantity: 0 }, { presentationId: countBases[0].id, quantity: 8 }]),
  ] };
  await assert.rejects(() => storeInventory.count(storeA.id, rejectedCount, admin), /reserved|reservation|stock/i);
  assert.equal(await physicalQuantity(catalogPacks[1].id), 2);
  assert.equal(await db.materialOperation.count({ where: { requestKey: rejectedCount.requestKey } }), 0);
  const groupedCount = { ...request(), note: 'Synthetic complete store count', products: [
    countEntry(0, [{ presentationId: catalogPacks[0].id, quantity: 0 }, { presentationId: countBases[0].id, quantity: 12 }]),
    countEntry(1, [{ presentationId: catalogPacks[1].id, quantity: 0 }]),
    countEntry(2, [{ presentationId: catalogPacks[2].id, quantity: 2 }]),
  ] };
  const counted = await storeInventory.count(storeA.id, groupedCount, admin);
  assert.equal(counted.countedProducts, 3); assert.equal(counted.countedPresentations, 4); assert.equal(counted.adjustedProducts, 3);
  assert.equal(counted.replayed, false); assert.equal('audit' in counted, false);
  assert.equal(await physicalQuantity(catalogPacks[0].id), 0); assert.equal(await physicalQuantity(countBases[0].id), 12);
  assert.equal(await physicalQuantity(catalogPacks[1].id), 0); assert.equal(await physicalQuantity(countBases[1].id), 4);
  assert.equal(await physicalQuantity(catalogPacks[2].id), 2); assert.equal(await physicalQuantity(catalogPacks[2].id, storeB.id), 3);
  for (const p of countProducts.slice(0, 3)) assert.equal((await db.materialProduct.findUnique({ where: { id: p.id } })).version, baselineProduct(p.id).version + 1);
  const countMovements = await db.materialMovement.findMany({ where: { operationKey: groupedCount.requestKey }, orderBy: { productId: 'asc' } });
  assert.equal(countMovements.length, 3); assert.equal(countMovements[0].deltaBaseUnits, 0);
  assert.equal(countMovements[0].kind, 'COUNT_ADJUSTMENT'); assert.equal(countMovements[0].details.source, 'STORE_COUNT');
  assert.equal(countMovements[0].details.changes.length, 2); assert.equal(countMovements[0].note, groupedCount.note);
  assert(countMovements.every(m => m.totalCost === null));
  console.log('PASS store-wide physical count includes 200 products/internal-only zero stock, final-state reservation validation, grouped packages, zero/omitted quantities and store isolation');

  await inventory.internalUse({ ...request(), productId: countProducts[1].id, presentationId: countBases[1].id, storeId: storeA.id, quantity: 1, recipient: 'Synthetic crew', note: 'After count' }, operator);
  const replayCount = await storeInventory.count(storeA.id, { ...groupedCount, products: [...groupedCount.products].reverse() }, admin);
  assert.equal(replayCount.replayed, true); assert.equal('audit' in replayCount, false);
  assert.deepEqual(replayCount.movementIds, counted.movementIds); assert.equal(await physicalQuantity(countBases[1].id), 3);
  await assert.rejects(() => storeInventory.count(storeA.id, { ...groupedCount, note: 'Changed payload' }, admin), /already used/i);
  const afterCount = await storeInventory.getInventory(storeA.id, admin);
  const staleCount = { ...request(), note: 'Synthetic stale batch', products: [
    { productId: countProducts[2].id, version: afterCount.products.find(p => p.id === countProducts[2].id).version, counts: [{ presentationId: catalogPacks[2].id, quantity: 9 }] },
    countEntry(1, [{ presentationId: countBases[1].id, quantity: 1 }]),
  ] };
  await assert.rejects(() => storeInventory.count(storeA.id, staleCount, admin), /changed|reload/i);
  assert.equal(await physicalQuantity(catalogPacks[2].id), 2); assert.equal(await physicalQuantity(countBases[1].id), 3);
  await assert.rejects(() => storeInventory.getInventory(storeA.id, customer), /authorized|warehouse staff/i);
  await assert.rejects(() => storeInventory.count(storeA.id, { ...groupedCount, ...request() }, operator), error => error.getStatus?.() === 403);
  const unchangedCount = { ...request(), note: 'Synthetic 200-product count without differences', products: afterCount.products.filter(p => p.code.startsWith('CAT-')).map(p => ({
    productId: p.id, version: p.version, counts: p.presentations.map(pack => ({ presentationId: pack.id, quantity: pack.quantity })),
  })) };
  const unchanged = await storeInventory.count(storeA.id, unchangedCount, admin);
  assert.equal(unchanged.countedProducts, 200); assert.equal(unchanged.countedPresentations, 400); assert.equal(unchanged.adjustedProducts, 0);
  assert.deepEqual(unchanged.movementIds, []);
  const unchangedAudit = await db.materialOperation.findUnique({ where: { requestKey: unchangedCount.requestKey } });
  assert.equal(unchangedAudit.result.audit.note, unchangedCount.note); assert.equal(unchangedAudit.result.audit.countedItems.length, 200);
  assert.equal(await db.materialMovement.count({ where: { operationKey: unchangedCount.requestKey } }), 0);
  const competingCounts = await Promise.allSettled([2, 3].map(quantity => storeInventory.count(storeA.id, {
    ...request(), note: 'Synthetic concurrent count', products: [countEntry(3, [{ presentationId: countBases[3].id, quantity }])],
  }, admin)));
  assert.equal(competingCounts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(competingCounts.filter(result => result.status === 'rejected').length, 1);
  assert([2, 3].includes(await physicalQuantity(countBases[3].id)));
  console.log('PASS atomic count conflicts, concurrent version locks, safe retry after later movements, role checks and durable audit for 200 unchanged counts');

  const storeIssues = new MaterialsStoreIssueService(db, inventory);
  const issueLine = (index, presentationId, quantity) => ({ productId: countProducts[index].id, presentationId, quantity });
  const issueInput = lines => ({ ...request(), recipient: 'Synthetic technician team', note: 'Installation job TEST-ONLY', lines });
  const issueSnapshot = await storeInventory.getInventory(storeA.id, operator);
  assert.equal(issueSnapshot.products.find(p => p.id === countProducts[0].id).presentations.find(p => p.isBase).availableQuantity, 3);
  assert.equal(issueSnapshot.products.find(p => p.id === countProducts[2].id).presentations.find(p => p.isBase).availableQuantity, 24);
  const tooManyTogether = issueInput([
    issueLine(1, countBases[1].id, 1),
    issueLine(2, countBases[2].id, 1),
    issueLine(2, catalogPacks[2].id, 2),
  ]);
  const beforeIssueVersion = (await db.materialProduct.findUnique({ where: { id: countProducts[1].id } })).version;
  await assert.rejects(() => storeIssues.internalUse(storeA.id, tooManyTogether, operator), /stock|available|insufficient/i);
  assert.equal(await physicalQuantity(countBases[1].id), 3);
  assert.equal(await physicalQuantity(catalogPacks[2].id), 2);
  assert.equal((await db.materialProduct.findUnique({ where: { id: countProducts[1].id } })).version, beforeIssueVersion);
  assert.equal(await db.materialOperation.count({ where: { requestKey: tooManyTogether.requestKey } }), 0);
  assert.equal(await db.materialMovement.count({ where: { operationKey: tooManyTogether.requestKey } }), 0);
  const reservedIssue = issueInput([issueLine(1, countBases[1].id, 1), issueLine(0, countBases[0].id, 4)]);
  await assert.rejects(() => storeIssues.internalUse(storeA.id, reservedIssue, admin), /stock|reserved|available|insufficient/i);
  assert.equal(await physicalQuantity(countBases[0].id), 12); assert.equal(await physicalQuantity(countBases[1].id), 3);
  const notificationsBeforeIssue = await db.notification.count();
  const salesBeforeIssue = await db.materialSale.count();
  const successfulIssue = issueInput([
    issueLine(2, countBases[2].id, 3), // Sent first intentionally: preserve the box requested below.
    issueLine(1, countBases[1].id, 2),
    issueLine(2, catalogPacks[2].id, 1),
    issueLine(0, countBases[0].id, 3),
  ]);
  const issued = await storeIssues.internalUse(storeA.id, successfulIssue, operator);
  assert.equal(issued.storeId, storeA.id); assert.equal(issued.productCount, 3); assert.equal(issued.lineCount, 4);
  assert.equal(issued.recipient, successfulIssue.recipient); assert.equal(issued.note, successfulIssue.note); assert.equal(issued.replayed, false);
  assert.equal(await physicalQuantity(countBases[0].id), 9); assert.equal(await physicalQuantity(countBases[1].id), 1);
  assert.equal(await physicalQuantity(countBases[2].id), 9); assert.equal(await physicalQuantity(catalogPacks[2].id), 0);
  assert.equal(await physicalQuantity(catalogPacks[2].id, storeB.id), 3);
  const issueMovements = await db.materialMovement.findMany({ where: { operationKey: successfulIssue.requestKey } });
  assert.equal(issueMovements.length, 4);
  assert(issueMovements.every(m => m.kind === 'INTERNAL_USE' && m.recipient === successfulIssue.recipient && m.note === successfulIssue.note && m.actorId === operator.id && m.storeId === storeA.id));
  assert(issueMovements.every(m => m.totalCost === null && m.saleId === null && m.details.source === 'STORE_INTERNAL_USE'));
  assert.equal(issueMovements.reduce((sum, m) => sum + m.deltaBaseUnits, 0), -20);
  const openedForIssue = issueMovements.find(m => m.presentationId === countBases[2].id).details.opened;
  assert.deepEqual(openedForIssue, [{ presentationId: catalogPacks[2].id, quantity: 1, baseUnits: 12 }]);
  assert.equal(await db.notification.count(), notificationsBeforeIssue); assert.equal(await db.materialSale.count(), salesBeforeIssue);
  console.log('PASS multi-material technician withdrawal: atomic quantities, mixed boxes/loose units, automatic opening, protected reservations, recipient/job audit and store isolation');

  await inventory.internalUse({ ...request(), productId: countProducts[1].id, presentationId: countBases[1].id, storeId: storeA.id, quantity: 1, recipient: 'Later synthetic technician', note: 'Later withdrawal' }, operator);
  const issueReplay = await storeIssues.internalUse(storeA.id, { ...successfulIssue, lines: [...successfulIssue.lines].reverse() }, operator);
  assert.equal(issueReplay.replayed, true); assert.deepEqual(issueReplay.movementIds, issued.movementIds);
  assert.equal(await physicalQuantity(countBases[1].id), 0); assert.equal(await physicalQuantity(countBases[2].id), 9);
  assert.equal(await db.materialMovement.count({ where: { operationKey: successfulIssue.requestKey } }), 4);
  await assert.rejects(() => storeIssues.internalUse(storeA.id, { ...successfulIssue, recipient: 'Changed recipient' }, operator), /already used/i);
  await assert.rejects(() => storeIssues.internalUse(storeA.id, issueInput([issueLine(2, countBases[2].id, 1)]), customer), error => error.getStatus?.() === 403);
  const competingIssues = await Promise.allSettled([1, 2].map(() => storeIssues.internalUse(storeA.id, issueInput([issueLine(2, countBases[2].id, 6)]), operator)));
  assert.equal(competingIssues.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(competingIssues.filter(item => item.status === 'rejected').length, 1);
  assert.equal(await physicalQuantity(countBases[2].id), 3);
  const sameIssue = issueInput([issueLine(2, countBases[2].id, 1)]);
  const sameIssueResults = await Promise.all([1, 2].map(() => storeIssues.internalUse(storeA.id, sameIssue, operator)));
  assert.equal(sameIssueResults.filter(item => item.replayed).length, 1);
  assert.equal(await physicalQuantity(countBases[2].id), 2);
  assert.equal(await db.materialMovement.count({ where: { operationKey: sameIssue.requestKey } }), 1);
  const internalOnly = catalogProducts[199];
  const internalOnlyBase = await db.materialPresentation.findFirst({ where: { productId: internalOnly.id, isBase: true } });
  await db.materialStock.create({ data: { productId: internalOnly.id, presentationId: internalOnlyBase.id, storeId: storeA.id, quantity: 7 } });
  await storeIssues.internalUse(storeA.id, issueInput([{ productId: internalOnly.id, presentationId: internalOnlyBase.id, quantity: 3 }]), admin);
  assert.equal(await physicalQuantity(internalOnlyBase.id), 4);
  assert.equal((await db.materialProduct.findUnique({ where: { id: internalOnly.id } })).isSaleEnabled, false);
  console.log('PASS concurrent technician withdrawals prevent overspending stock; same-key retries deduct once, staff permissions and internal-only products work');
}
main().catch(error => { console.error(error.stderr?.toString() || error.stack || error.message); process.exitCode = 1; }).finally(async () => {
  if (db) await db.$disconnect();
  if (created) { sql(`DROP DATABASE \`${database}\``, false); console.log('Removed disposable database. Existing application data unchanged; no external payment calls.'); }
});
