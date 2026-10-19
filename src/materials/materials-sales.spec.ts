import { Prisma } from '@prisma/client';
import { MaterialsSalesService } from './materials-sales.service';
import { MaterialsInventoryService } from './materials-inventory.service';

const D = (value: string | number) => new Prisma.Decimal(value);
const admin = { id: 9, role: { name: 'admin' as const } };
const customer = { id: 7, role: { name: 'client' as const } };
const requestKey = '956fcf32-2cca-4cbf-8e50-cc68919c9ea9';

function fixture() {
  const payments: any[] = [];
  const operations = new Map<string, any>();
  const sale: any = {
    id: 1, code: 'MS-TEST', publicToken: 'a'.repeat(64), status: 'CONFIRMED', storeId: 1,
    store: { id: 1, name: 'Shelf A', isActive: true }, customerName: 'Customer', customerEmail: 'buyer@example.test', customerPhone: null,
    note: 'Staff only note', subtotal: D(100), discountAmount: D(0), taxRate: D(0), taxAmount: D(0), total: D(100), paidAmount: D(0),
    currency: 'usd', requireFullPayment: true, createdById: 9, customerUserId: null, version: 0, expiresAt: null,
    createdAt: new Date(), confirmedAt: new Date(), deliveredAt: null, canceledAt: null,
    lines: [{ id: 1, productId: 1, storeId: 1, presentationId: 1, productName: 'Caulking', productCode: 'MAT-1', presentationName: 'Tube', multiplier: 1, quantity: 4, unitPrice: D(25), lineTotal: D(100) }], payments,
  };
  const db: any = {
    $queryRaw: jest.fn(async () => [{ id: 1 }]),
    $transaction: jest.fn(async (work: any) => work(db)),
    materialSale: {
      findUnique: jest.fn(async ({ where }) => where.id === 1 || where.publicToken === sale.publicToken ? sale : null),
      findMany: jest.fn(async () => [sale]), count: jest.fn(async () => 0),
      update: jest.fn(async ({ data }) => { for (const [key, value] of Object.entries(data)) sale[key] = key === 'version' ? sale.version + 1 : value; return sale; }),
      create: jest.fn(async ({ data }) => {
        Object.assign(sale, data, { id: 1, lines: data.lines.create.map((line: any, i: number) => ({ id: i + 1, ...line })), payments });
        return sale;
      }),
    },
    materialPayment: {
      findUnique: jest.fn(async ({ where }) => payments.find(p => where.id ? p.id === where.id : p.requestKey === where.requestKey) || null),
      findUniqueOrThrow: jest.fn(async ({ where }) => payments.find(p => p.id === where.id)),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async ({ where }) => payments.filter(p => p.saleId === where.saleId && p.status === where.status)),
      create: jest.fn(async ({ data }) => { const p = { id: payments.length + 11, createdAt: new Date(), status: 'PENDING', refundedAmount: D(0), currency: 'usd', stripeSessionId: null, ...data }; payments.push(p); return p; }),
      update: jest.fn(async ({ where, data }) => Object.assign(payments.find(p => p.id === where.id), data)),
      updateMany: jest.fn(async ({ where, data }) => { const p = payments.find(p => p.id === where.id && p.status === where.status && !p.stripeSessionId); if (p) Object.assign(p, data); return { count: p ? 1 : 0 }; }),
    },
    globalParameter: { findUnique: jest.fn(async () => ({ value: D('.07') })) },
    warehouseStore: { findUnique: jest.fn(async () => sale.store), findMany: jest.fn(async () => [sale.store]) },
    materialPresentation: { findMany: jest.fn(async () => []) },
    materialOperation: {
      findUnique: jest.fn(async ({ where }) => operations.get(where.requestKey) ?? null),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }) => { operations.set(data.requestKey, data); return data; }),
    },
    materialProduct: { findMany: jest.fn(async () => []) },
    user: { findUnique: jest.fn(async ({ where }) => ({ id: where.id, username: 'buyer', firstName: 'Account', lastName: 'Buyer', email: 'ACCOUNT@example.test', phone: '555-0100', isActive: true, deletedAt: null, role: { name: 'client' } })), findMany: jest.fn(async () => []) },
    eventLog: { create: jest.fn(async () => ({})) },
  };
  const inventory: any = {
    operation: jest.fn(async (_key, _payload, _actor, _kind, work) => work(db)),
    lockProducts: jest.fn(async () => {}),
    lockStores: jest.fn(async () => {}),
    loadStock: jest.fn(async () => ({ basePresentationId: 1, packs: [{ id: 1, baseUnits: 1, quantity: 0 }, { id: 2, baseUnits: 20, quantity: 3 }], reservations: [] })),
    deliverSale: jest.fn(async () => []),
  };
  const stripe: any = {
    checkout: { sessions: { create: jest.fn(), retrieve: jest.fn(), expire: jest.fn(), list: jest.fn() } },
    charges: { retrieve: jest.fn() }, paymentIntents: { retrieve: jest.fn() }, refunds: { list: jest.fn() },
  };
  const notifications: any = { createAndSendToRoles: jest.fn(async () => []), createAndSend: jest.fn(async () => null) };
  const saleEmails: any = { enqueue: jest.fn(async () => {}) };
  const service = new MaterialsSalesService(db, { get: () => 'https://shop.example.test' } as any, inventory, notifications, saleEmails);
  (service as any).stripeClient = stripe;
  const pending = () => {
    const p = { id: 11, saleId: 1, requestKey, requestHash: 'hash', status: 'PENDING', source: 'STRIPE', amount: D(100), refundedAmount: D(0), currency: 'usd', paymentMethod: 'CARD', stripeSessionId: 'cs_test', stripePaymentIntentId: null, createdAt: new Date(), expiresAt: new Date(Date.now() + 3600000) };
    payments.push(p); return p;
  };
  const session = (extra = {}) => ({ id: 'cs_test', mode: 'payment', metadata: { materialSaleId: '1', materialPaymentId: '11' }, amount_total: 10000, currency: 'usd', status: 'complete', payment_status: 'paid', payment_intent: 'pi_test', ...extra });
  return { service, db, inventory, stripe, sale, payments, pending, session, notifications, operations, saleEmails };
}

function cartFixture() {
  const f = fixture();
  const p = { id: 1, productId: 1, isBase: true, isActive: true, isSaleEnabled: true, multiplier: 1, name: 'Tube', salePrice: D(1), product: { id: 1, name: 'Caulking', code: 'MAT-1', isActive: true, isSaleEnabled: true, allowBaseUnitOperations: true } };
  f.db.materialPresentation.findMany.mockResolvedValue([p]);
  return { ...f, presentation: p, cart: { requestKey, lines: [{ presentationId: 1, quantity: 2 }] } };
}

function customerOrderFixture() {
  const f = fixture();
  f.sale.createdById = customer.id;
  f.sale.customerUserId = customer.id;
  f.sale.expiresAt = new Date(Date.now() + 30 * 60000);
  return f;
}

describe('Material sales with a concurrently deleted presentation', () => {
  it.each([true, false])('rejects restricted single-unit staff, customer and draft sales (isBase=%s)', async isBase => {
    const f = cartFixture();
    f.presentation.product.allowBaseUnitOperations = false;
    f.presentation.isBase = isBase;
    await expect(f.service.create({ ...f.cart, storeId: 1, customerName: 'Buyer' }, admin)).rejects.toThrow('complete packages only');
    await expect(f.service.createCustomerOrder(f.cart, customer)).rejects.toThrow('complete packages only');
    f.sale.status = 'DRAFT';
    await expect(f.service.confirm(1, admin)).rejects.toThrow('complete packages only');
    expect(f.db.materialSale.create).not.toHaveBeenCalled();
    expect(f.db.materialSale.update).not.toHaveBeenCalled();
    expect(f.inventory.loadStock).not.toHaveBeenCalled();
  });

  it('rechecks policy after the product lock when creating a stale staff draft', async () => {
    const f = cartFixture();
    f.inventory.lockProducts.mockImplementation(async () => { f.presentation.product.allowBaseUnitOperations = false; });
    await expect(f.service.create({ ...f.cart, storeId: 1, customerName: 'Buyer' }, admin)).rejects.toThrow('complete packages only');
    expect(f.db.materialSale.create).not.toHaveBeenCalled();
  });

  it('allows a restricted whole-package customer purchase', async () => {
    const f = cartFixture();
    Object.assign(f.presentation, { id: 2, isBase: false, multiplier: 20, name: 'Box' });
    f.presentation.product.allowBaseUnitOperations = false;
    const result = await f.service.createCustomerOrder({ ...f.cart, lines: [{ presentationId: 2, quantity: 1 }] }, customer);
    expect(result.status).toBe('CONFIRMED');
    expect(f.db.materialSale.create.mock.calls[0][0].data.lines.create[0]).toMatchObject({ multiplier: 20, quantity: 1 });
  });

  it('rejects a staff draft when the selected presentation disappears while acquiring the product lock', async () => {
    const f = cartFixture();
    f.inventory.lockProducts.mockImplementation(async () => {
      f.db.materialPresentation.findMany.mockResolvedValue([]);
    });

    await expect(f.service.create({ ...f.cart, storeId: 1, customerName: 'Walk-in Buyer' }, admin))
      .rejects.toMatchObject({ status: 409, message: 'A material presentation is no longer available. Reload the sale before saving.' });
    expect(f.inventory.lockProducts).toHaveBeenCalledWith(f.db, [1]);
    expect(f.db.materialPresentation.findMany).toHaveBeenCalledTimes(2);
    expect(f.db.materialSale.create).not.toHaveBeenCalled();
    expect(f.inventory.loadStock).not.toHaveBeenCalled();
  });

  it('rejects an online checkout when the selected presentation disappears while acquiring the product lock', async () => {
    const f = cartFixture();
    f.inventory.lockProducts.mockImplementation(async () => {
      f.db.materialPresentation.findMany.mockResolvedValue([]);
    });

    await expect(f.service.createCustomerOrder(f.cart, customer))
      .rejects.toMatchObject({ status: 409, message: 'An item in your cart is no longer available.' });
    expect(f.inventory.lockProducts).toHaveBeenCalledWith(f.db, [1]);
    expect(f.db.materialPresentation.findMany).toHaveBeenCalledTimes(2);
    expect(f.db.materialSale.create).not.toHaveBeenCalled();
    expect(f.inventory.loadStock).not.toHaveBeenCalled();
    expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe('Direct material sales customer identity', () => {
  it('snapshots a selected account while keeping the staff creator separate', async () => {
    const f = cartFixture();
    const result = await f.service.create({ ...f.cart, storeId: 1, customerUserId: customer.id }, admin);
    expect(result).toMatchObject({ customerUserId: customer.id, customerName: 'Account Buyer', customerEmail: 'account@example.test', customerPhone: '555-0100' });
    expect(f.db.materialSale.create.mock.calls[0][0].data).toMatchObject({ customerUserId: customer.id, createdById: admin.id });
    expect((await f.service.getCustomerOrder(1, customer)).canCancel).toBe(false);
    await expect(f.service.getCustomerOrder(1, admin)).rejects.toThrow('not found');
    await expect(f.service.cancelCustomerOrder(1, customer)).rejects.toThrow('cannot be canceled online');
    expect(f.inventory.deliverSale).not.toHaveBeenCalled();
    f.sale.status = 'DRAFT';
    await expect(f.service.getCustomerOrder(1, customer)).rejects.toThrow('not found');
    await expect(f.service.getPublic(f.sale.publicToken)).rejects.toThrow('not found');
  });

  it('keeps a manual customer unregistered even when their email matches an existing account', async () => {
    const f = cartFixture();
    const result = await f.service.create({ ...f.cart, storeId: 1, customerName: ' Walk-in Buyer ', customerEmail: ' ACCOUNT@example.test ', customerPhone: ' 555-0199 ' }, admin);
    expect(result).toMatchObject({ customerUserId: null, customerName: 'Walk-in Buyer', customerEmail: 'account@example.test', customerPhone: '555-0199' });
    expect(f.db.user.findUnique).not.toHaveBeenCalled();
    expect(f.db.user.findMany).not.toHaveBeenCalled();
    await expect(f.service.getCustomerOrder(1, admin)).rejects.toThrow('not found');
    await expect(f.service.getCustomerOrder(1, customer)).rejects.toThrow('not found');
  });

  it('allows a manual sale without optional contact details but requires a name', async () => {
    const f = cartFixture();
    await expect(f.service.create({ ...f.cart, storeId: 1 }, admin)).rejects.toThrow('customer name');
    expect(f.db.materialSale.create).not.toHaveBeenCalled();
    await expect(f.service.create({ ...f.cart, storeId: 1, customerName: 'Walk-in Buyer' }, admin)).resolves.toMatchObject({ customerUserId: null, customerEmail: null, customerPhone: null });
  });

  it.each(['customerName', 'customerEmail', 'customerPhone'])('rejects a selected account mixed with %s', async field => {
    const f = cartFixture();
    await expect(f.service.create({ ...f.cart, storeId: 1, customerUserId: customer.id, [field]: 'spoofed' }, admin)).rejects.toThrow('not both');
    expect(f.db.user.findUnique).not.toHaveBeenCalled();
    expect(f.db.materialSale.create).not.toHaveBeenCalled();
  });

  it.each([null, { isActive: false }, { deletedAt: new Date() }, { role: { name: 'technician' } }])('refuses an unavailable selected account', async patch => {
    const f = cartFixture();
    f.db.user.findUnique.mockResolvedValue(patch === null ? null : { isActive: true, deletedAt: null, role: { name: 'client' }, ...patch });
    await expect(f.service.create({ ...f.cart, storeId: 1, customerUserId: customer.id }, admin)).rejects.toThrow('active customer account');
    expect(f.db.materialSale.create).not.toHaveBeenCalled();
  });

  it('replays the original selected customer snapshot and rejects changing its buyer on retry', async () => {
    const f = cartFixture();
    f.db.materialOperation.update = jest.fn(async ({ where, data }) => Object.assign(f.operations.get(where.requestKey), data));
    const inventory = new MaterialsInventoryService(f.db);
    f.inventory.operation.mockImplementation(inventory.operation.bind(inventory));
    const payload = { ...f.cart, storeId: 1, customerUserId: customer.id };
    const first = await f.service.create(payload, admin);
    f.db.user.findUnique.mockResolvedValue({ id: customer.id, username: 'edited', firstName: 'New', lastName: 'Profile', email: 'new@example.test', phone: null, isActive: false, deletedAt: null, role: { name: 'client' } });
    await expect(f.service.create(payload, admin)).resolves.toEqual({ ...first, replayed: true });
    expect(f.db.user.findUnique).toHaveBeenCalledTimes(1);
    await expect(f.service.create({ ...payload, customerUserId: 8 }, admin)).rejects.toThrow('already used');
    await expect(f.service.create({ ...f.cart, storeId: 1, customerName: 'Manual' }, admin)).rejects.toThrow('already used');
    expect(f.db.materialSale.create).toHaveBeenCalledTimes(1);
  });

  it('limits staff customer searches to active shopping accounts and returns only safe contact fields', async () => {
    const f = fixture();
    await expect(f.service.searchCustomers(customer, { q: 'Buyer' })).rejects.toThrow('warehouse staff');
    expect(await f.service.searchCustomers(admin, { q: ' ' })).toEqual([]);
    expect(await f.service.searchCustomers(admin, { q: 'A' })).toEqual([]);
    expect(f.db.user.findMany).not.toHaveBeenCalled();
    f.db.user.findMany.mockResolvedValue([{ id: 7, username: 'buyer', firstName: 'Account', lastName: 'Buyer', email: 'account@example.test', phone: '555-0100', password: 'not returned' }]);
    expect(await f.service.searchCustomers(admin, { q: ' Account Buyer ' })).toEqual([{ id: 7, name: 'Account Buyer', email: 'account@example.test', phone: '555-0100' }]);
    expect(f.db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 20, where: expect.objectContaining({ isActive: true, deletedAt: null, role: { name: { in: ['admin', 'operator', 'client', 'dealer'] } }, AND: expect.any(Array) }), select: { id: true, username: true, firstName: true, lastName: true, email: true, phone: true } }));
    expect(f.db.user.findMany.mock.calls[0][0].where.AND).toHaveLength(2);
  });
});

describe('Material purchase notifications and customer order history', () => {
  it('queues all administrator alerts in the full-payment transaction, never for a partial payment', async () => {
    const f = fixture();
    const dto: any = { requestKey, amount: 40, paymentMethod: 'CASH', fundsVerified: true };
    await f.service.recordPayment(1, dto, admin);
    expect(f.notifications.createAndSendToRoles).not.toHaveBeenCalled();
    const final = { ...dto, requestKey: 'final-payment', amount: 60 };
    await f.service.recordPayment(1, final, admin);
    await f.service.recordPayment(1, final, admin);
    expect(f.notifications.createAndSendToRoles).toHaveBeenCalledTimes(1);
    expect(f.notifications.createAndSendToRoles).toHaveBeenCalledWith(['admin'], expect.objectContaining({
      actorId: admin.id, notifyActor: true, dedupeKey: 'material-sale:1:paid',
      actionUrl: '/warehouse/materials/sales/1', message: expect.stringContaining('Material order #MS-TEST from Customer is fully paid (USD 100.00)'),
    }), { db: f.db });
    expect(f.notifications.createAndSend).not.toHaveBeenCalled();
    expect(f.operations.get('material-sale-paid:1').kind).toBe('MATERIAL_SALE_PAID');
  });

  it('emails an online buyer with an invoice link once and excludes that account from duplicate administrator notices', async () => {
    const f = fixture(); f.pending();
    f.sale.customerUserId = admin.id;
    f.stripe.checkout.sessions.retrieve.mockResolvedValue(f.session());
    const event: any = { type: 'checkout.session.completed', data: { object: f.session() } };
    await f.service.handleVerifiedStripeEvent(event);
    await f.service.handleVerifiedStripeEvent(event);
    expect(f.notifications.createAndSend).toHaveBeenCalledTimes(1);
    expect(f.notifications.createAndSend).toHaveBeenCalledWith(expect.objectContaining({
      recipientId: admin.id, actorId: admin.id, notifyActor: true, dedupeKey: 'material-sale:1:paid:customer',
      actionUrl: `/public/material-sales/${f.sale.publicToken}`, actionLabel: 'View order and invoice',
      message: expect.stringContaining('Your material order #MS-TEST is paid in full (USD 100.00)'),
    }), f.db);
    expect(f.notifications.createAndSendToRoles).toHaveBeenCalledWith(['admin'], expect.any(Object), { db: f.db, excludeUserIds: [admin.id] });
  });

  it('notifies the selected buyer of a direct purchase, never the creator as the buyer', async () => {
    const f = fixture(); f.sale.customerUserId = customer.id;
    await f.service.recordPayment(1, { requestKey, amount: 100, paymentMethod: 'CASH', fundsVerified: true }, admin);
    expect(f.notifications.createAndSend).toHaveBeenCalledWith(expect.objectContaining({ recipientId: customer.id, actionLabel: 'View order and invoice' }), f.db);
    expect(f.notifications.createAndSendToRoles).toHaveBeenCalledWith(['admin'], expect.any(Object), { db: f.db, excludeUserIds: [customer.id] });
    expect(f.saleEmails.enqueue).not.toHaveBeenCalled();
    expect(f.db.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: customer.id } }));
  });

  it('queues a guest invoice email in the same transaction once without matching any account', async () => {
    const f = fixture();
    const dto = { requestKey, amount: 100, paymentMethod: 'CASH' as const, fundsVerified: true as const };
    await f.service.recordPayment(1, dto, admin);
    await f.service.recordPayment(1, dto, admin);
    expect(f.saleEmails.enqueue).toHaveBeenCalledTimes(1);
    expect(f.saleEmails.enqueue).toHaveBeenCalledWith(f.sale, f.db);
    expect(f.notifications.createAndSend).not.toHaveBeenCalled();
    expect(f.db.user.findUnique).not.toHaveBeenCalled();
  });

  it.each(['no email', 'inactive registered account'])('does not redirect a receipt for %s', async kind => {
    const f = fixture();
    if (kind === 'no email') f.sale.customerEmail = null;
    else { f.sale.customerUserId = customer.id; f.db.user.findUnique.mockResolvedValue({ id: customer.id, isActive: false, deletedAt: null }); }
    await f.service.recordPayment(1, { requestKey, amount: 100, paymentMethod: 'CASH', fundsVerified: true }, admin);
    expect(f.saleEmails.enqueue).not.toHaveBeenCalled();
    expect(f.notifications.createAndSend).not.toHaveBeenCalled();
    expect(f.notifications.createAndSendToRoles).toHaveBeenCalledTimes(1);
  });

  it('does not announce another purchase after a refund and re-payment, even when bell notifications were dismissed', async () => {
    const f = fixture();
    await f.service.recordPayment(1, { requestKey, amount: 100, paymentMethod: 'CASH', fundsVerified: true } as any, admin);
    f.payments[0].refundedAmount = D(25); f.sale.paidAmount = D(75);
    await f.service.recordPayment(1, { requestKey: 'repayment', amount: 25, paymentMethod: 'CASH', fundsVerified: true } as any, admin);
    expect(f.notifications.createAndSendToRoles).toHaveBeenCalledTimes(1);
    expect(f.db.materialOperation.create).toHaveBeenCalledTimes(1);
  });

  it.each(['open', 'expired'])('does not announce an unpaid %s Stripe attempt', async status => {
    const f = fixture(); f.pending();
    const session = f.session({ status, payment_status: 'unpaid' });
    f.stripe.checkout.sessions.retrieve.mockResolvedValue(session);
    await f.service.handleVerifiedStripeEvent({ type: 'checkout.session.completed', data: { object: session } } as any);
    expect(f.notifications.createAndSendToRoles).not.toHaveBeenCalled();
    expect(f.notifications.createAndSend).not.toHaveBeenCalled();
  });

  it('does not turn a historical charge/refund update into a new purchase announcement', async () => {
    const f = fixture(); const payment = f.pending(); payment.status = 'PAID'; payment.stripePaymentIntentId = 'pi_test'; f.sale.paidAmount = D(100);
    f.db.materialPayment.findFirst.mockResolvedValue(payment);
    f.stripe.charges.retrieve.mockResolvedValue({ id: 'ch_test', payment_intent: 'pi_test', currency: 'usd', amount: 10000 });
    f.stripe.refunds.list.mockResolvedValue({ data: [], has_more: false });
    await f.service.handleVerifiedStripeEvent({ type: 'charge.updated', data: { object: { object: 'charge', id: 'ch_test' } } } as any);
    expect(f.sale.paidAmount.toFixed(2)).toBe('100.00');
    expect(f.notifications.createAndSendToRoles).not.toHaveBeenCalled();
    expect(f.notifications.createAndSend).not.toHaveBeenCalled();
    expect(f.db.materialOperation.create).not.toHaveBeenCalled();
  });

  it('requires a successful notification transaction before acknowledging a payment', async () => {
    const f = fixture();
    f.notifications.createAndSendToRoles.mockRejectedValue(new Error('outbox unavailable'));
    await expect(f.service.recordPayment(1, { requestKey, amount: 100, paymentMethod: 'CASH', fundsVerified: true } as any, admin)).rejects.toThrow('outbox unavailable');
  });

  it('paginates purchases owned by the authenticated buyer, excluding drafts and private fields', async () => {
    const f = customerOrderFixture();
    f.sale.expiresAt = null; f.sale.paidAmount = D(100);
    f.db.materialSale.count.mockResolvedValue(51);
    const result = await f.service.listCustomerOrders(customer, { page: '2', pageSize: '100' });
    expect(result).toMatchObject({ total: 51, page: 2, pageSize: 50, items: [{ id: 1, canCancel: false }] });
    expect(result.items[0]).not.toHaveProperty('note');
    expect(result.items[0]).not.toHaveProperty('publicToken');
    expect(result.items[0]).toHaveProperty('publicUrl');
    expect(f.db.materialSale.count).toHaveBeenCalledWith({ where: { customerUserId: customer.id, status: { not: 'DRAFT' } } });
    expect(f.db.materialSale.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { customerUserId: customer.id, status: { not: 'DRAFT' } }, take: 50, skip: 50 }));
  });

  it('validates pagination and searches warehouse order references before limiting results', async () => {
    const f = fixture();
    await expect(f.service.listCustomerOrders(customer, { page: '-1' })).rejects.toThrow('valid order page');
    await expect(f.service.listCustomerOrders({ id: 5, role: { name: 'technician' } } as any)).rejects.toThrow('authorized');
    await f.service.list(admin, { q: ' MS-OLD ' });
    expect(f.db.materialSale.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { OR: [{ code: { contains: 'MS-OLD' } }, { customerName: { contains: 'MS-OLD' } }, { customerEmail: { contains: 'MS-OLD' } }] }, take: 200 }));
  });
});

describe('Customer cancellation of material orders', () => {
  it('exposes a cancel action only for an owned, unpaid catalog reservation', async () => {
    const f = customerOrderFixture();
    const order = await f.service.getCustomerOrder(1, customer);
    expect(order.canCancel).toBe(true);
    expect(order).toMatchObject({ id: 1, publicUrl: `https://shop.example.test/public/material-sales/${f.sale.publicToken}` });
    expect(order).not.toHaveProperty('note');
    expect(order).not.toHaveProperty('publicToken');
    expect(order.lines[0]).not.toHaveProperty('storeId');
    f.sale.expiresAt = null;
    expect((await f.service.getCustomerOrder(1, customer)).canCancel).toBe(false);
    f.sale.paidAmount = D(100);
    expect((await f.service.getCustomerOrder(1, customer)).canCancel).toBe(false);
  });

  it('checks the authenticated owner before any Stripe call or reservation mutation', async () => {
    const f = customerOrderFixture(); f.pending();
    await expect(f.service.getCustomerOrder(1, { ...customer, id: 8 })).rejects.toThrow('not found');
    await expect(f.service.cancelCustomerOrder(1, { ...customer, id: 8 })).rejects.toThrow('not found');
    await expect(f.service.cancelCustomerOrder(1, admin)).rejects.toThrow('not found');
    await expect(f.service.cancelCustomerOrder(1, undefined as any)).rejects.toThrow('authorized account');
    expect(f.stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(f.stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(f.db.materialSale.update).not.toHaveBeenCalled();
  });

  it.each(['staff', 'draft', 'delivered', 'paid', 'refunded'])('does not allow a customer to cancel a %s order', async kind => {
    const f = customerOrderFixture();
    if (kind === 'staff') f.sale.expiresAt = null;
    if (kind === 'draft') f.sale.status = 'DRAFT';
    if (kind === 'delivered') f.sale.status = 'DELIVERED';
    if (kind === 'paid') f.sale.paidAmount = D(1);
    if (kind === 'refunded') { const payment = f.pending(); payment.status = 'PAID'; payment.refundedAmount = D(100); }
    if (kind === 'draft') await expect(f.service.getCustomerOrder(1, customer)).rejects.toThrow('not found');
    else expect((await f.service.getCustomerOrder(1, customer)).canCancel).toBe(false);
    await expect(f.service.cancelCustomerOrder(1, customer)).rejects.toThrow();
    expect(f.stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(f.db.materialSale.update).not.toHaveBeenCalled();
    expect(f.inventory.lockProducts).not.toHaveBeenCalled();
  });

  it('cancels a reservation without a checkout once, without deducting any physical stock', async () => {
    const f = customerOrderFixture();
    const result = await f.service.cancelCustomerOrder(1, customer);
    expect(result).toMatchObject({ status: 'CANCELED', canCancel: false });
    expect(await f.service.cancelCustomerOrder(1, customer)).toEqual(result);
    expect(f.inventory.lockProducts).toHaveBeenCalledWith(f.db, [1]);
    expect(f.db.materialSale.update).toHaveBeenCalledTimes(1);
    expect(f.db.eventLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: customer.id }) }));
    expect(f.inventory.deliverSale).not.toHaveBeenCalled();
    expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    await expect(f.service.checkoutForPublic(f.sale.publicToken)).rejects.toThrow('not available for payment');
  });

  it('expires an open Stripe session before canceling and releases reservations idempotently', async () => {
    const f = customerOrderFixture(); f.pending();
    f.stripe.checkout.sessions.retrieve.mockResolvedValue(f.session({ status: 'open', payment_status: 'unpaid' }));
    f.stripe.checkout.sessions.expire.mockImplementation(async () => {
      expect(f.sale.status).toBe('CONFIRMED');
      expect(f.inventory.lockProducts).not.toHaveBeenCalled();
      return f.session({ status: 'expired', payment_status: 'unpaid' });
    });
    expect((await f.service.cancelCustomerOrder(1, customer)).status).toBe('CANCELED');
    expect((await f.service.cancelCustomerOrder(1, customer)).status).toBe('CANCELED');
    expect(f.payments[0].status).toBe('EXPIRED');
    expect(f.stripe.checkout.sessions.expire).toHaveBeenCalledTimes(1);
    expect(f.db.materialSale.update).toHaveBeenCalledTimes(1);
  });

  it('recovers an unlinked pending attempt with the same key and expires it before releasing stock', async () => {
    const f = customerOrderFixture(); const pending = f.pending(); pending.stripeSessionId = null;
    f.stripe.checkout.sessions.create.mockResolvedValue(f.session({ status: 'open', payment_status: 'unpaid', payment_intent: null, url: 'https://checkout.stripe.test/session' }));
    f.stripe.checkout.sessions.expire.mockResolvedValue(f.session({ status: 'expired', payment_status: 'unpaid', payment_intent: null }));
    expect((await f.service.cancelCustomerOrder(1, customer)).status).toBe('CANCELED');
    expect(f.stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: `materials:${requestKey}` });
    expect(f.db.materialPayment.create).not.toHaveBeenCalled();
    expect(f.stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_test');
  });

  it.each(['unknown', 'processing', 'unlinked'])('retains a reservation for an %s Stripe result', async kind => {
    const f = customerOrderFixture(); const pending = f.pending();
    if (kind === 'processing') f.stripe.checkout.sessions.retrieve.mockResolvedValue(f.session({ status: 'complete', payment_status: 'unpaid' }));
    else if (kind === 'unlinked') {
      pending.stripeSessionId = null;
      f.stripe.checkout.sessions.create.mockRejectedValue(new Error('network timeout'));
    } else f.stripe.checkout.sessions.retrieve.mockRejectedValue(new Error('provider unavailable'));
    await expect(f.service.cancelCustomerOrder(1, customer)).rejects.toThrow();
    expect(f.sale.status).toBe('CONFIRMED');
    expect(pending.status).toBe('PENDING');
    expect(f.db.materialSale.update).not.toHaveBeenCalled();
    expect(f.inventory.lockProducts).not.toHaveBeenCalled();
  });

  it('keeps an order reserved when Stripe payment succeeds during cancellation', async () => {
    const f = customerOrderFixture(); f.pending();
    f.stripe.checkout.sessions.retrieve.mockResolvedValueOnce(f.session({ status: 'open', payment_status: 'unpaid' })).mockResolvedValueOnce(f.session());
    f.stripe.checkout.sessions.expire.mockRejectedValue(new Error('Session already completed'));
    await expect(f.service.cancelCustomerOrder(1, customer)).rejects.toThrow('received a payment');
    expect(f.sale.status).toBe('CONFIRMED');
    expect(f.sale.paidAmount.toFixed(2)).toBe('100.00');
    expect(f.sale.expiresAt).toBeNull();
    expect(f.inventory.lockProducts).not.toHaveBeenCalled();
  });

  it('does not release inventory when another checkout starts after the provider snapshot', async () => {
    const f = customerOrderFixture(); const first = f.pending();
    f.stripe.checkout.sessions.retrieve.mockResolvedValue(f.session({ status: 'open', payment_status: 'unpaid' }));
    f.stripe.checkout.sessions.expire.mockImplementation(async () => {
      // Interleave a competing checkout after this attempt expires and before final cancellation.
      first.status = 'EXPIRED';
      f.stripe.checkout.sessions.create.mockResolvedValue(f.session({ id: 'cs_new', metadata: { materialSaleId: '1', materialPaymentId: '12' }, status: 'open', payment_status: 'unpaid', payment_intent: null, url: 'https://checkout.stripe.test/new' }));
      await f.service.checkoutForPublic(f.sale.publicToken);
      return f.session({ status: 'expired', payment_status: 'unpaid' });
    });
    await expect(f.service.cancelCustomerOrder(1, customer)).rejects.toThrow('still processing');
    expect(f.sale.status).toBe('CONFIRMED');
    expect(f.payments.map(payment => payment.status)).toEqual(['EXPIRED', 'PENDING']);
    expect(f.inventory.lockProducts).not.toHaveBeenCalled();
    expect(f.db.materialSale.update).not.toHaveBeenCalled();
  });
});

describe('Material sales and verified payments', () => {
  it('restricts sales operations to warehouse staff', async () => {
    const f = fixture();
    await expect(f.service.list({ id: 2, role: { name: 'client' } })).rejects.toThrow('Only warehouse staff');
    expect(f.db.materialSale.findMany).not.toHaveBeenCalled();
  });

  it('keeps staff metadata and internal locations out of public payment pages', async () => {
    const f = fixture();
    const result = await f.service.getPublic(f.sale.publicToken);
    expect(result).not.toHaveProperty('note');
    expect(result).not.toHaveProperty('publicToken');
    expect(result).not.toHaveProperty('store');
    expect(result.lines[0]).not.toHaveProperty('storeId');
    expect(result.total).toBe('100.00');
    await expect(f.service.getPublic('guess')).rejects.toThrow('not found');
  });

  it('reserves loose units contained in closed boxes without changing physical stock', async () => {
    const f = fixture(); f.sale.status = 'DRAFT';
    f.db.materialPresentation.findMany.mockResolvedValue([{ id: 1, multiplier: 1, isActive: true, isSaleEnabled: true, product: { isActive: true, isSaleEnabled: true } }]);
    const result = await f.service.confirm(1, admin);
    expect(result.status).toBe('CONFIRMED');
    expect(f.inventory.deliverSale).not.toHaveBeenCalled();
    expect(f.inventory.loadStock).toHaveBeenCalledWith(f.db, 1, 1, 1);
    expect(f.db.$transaction.mock.calls[0][1].isolationLevel).toBe('ReadCommitted');
  });

  it('rejects confirmation when other reservations leave insufficient units', async () => {
    const f = fixture(); f.sale.status = 'DRAFT';
    f.db.materialPresentation.findMany.mockResolvedValue([{ id: 1, multiplier: 1, isActive: true, isSaleEnabled: true, product: { isActive: true, isSaleEnabled: true } }]);
    f.inventory.loadStock.mockResolvedValue({ basePresentationId: 1, packs: [{ id: 1, baseUnits: 1, quantity: 0 }, { id: 2, baseUnits: 20, quantity: 3 }], reservations: [{ presentationId: 1, quantity: 58 }] });
    await expect(f.service.confirm(1, admin)).rejects.toThrow('Insufficient');
    expect(f.db.materialSale.update).not.toHaveBeenCalled();
  });

  it('accepts a partial manual receipt idempotently and rejects changed retries', async () => {
    const f = fixture();
    const dto: any = { requestKey, amount: 40, paymentMethod: 'CASH', fundsVerified: true };
    expect((await f.service.recordPayment(1, dto, admin)).balance).toBe('60.00');
    expect((await f.service.recordPayment(1, dto, admin)).balance).toBe('60.00');
    expect(f.db.materialPayment.create).toHaveBeenCalledTimes(1);
    await expect(f.service.recordPayment(1, { ...dto, amount: 30 }, admin)).rejects.toThrow('different information');
  });

  it('does not accept overpayments, unverified funds, or manual card confirmations', async () => {
    const f = fixture();
    const dto: any = { requestKey, amount: 101, paymentMethod: 'CASH', fundsVerified: true };
    await expect(f.service.recordPayment(1, dto, admin)).rejects.toThrow('exceeds');
    await expect(f.service.recordPayment(1, { ...dto, amount: 20, fundsVerified: false }, admin)).rejects.toThrow('Verify');
    await expect(f.service.recordPayment(1, { ...dto, amount: 20, paymentMethod: 'CARD' }, admin)).rejects.toThrow('Stripe');
    expect(f.db.materialPayment.create).not.toHaveBeenCalled();
  });

  it('blocks competing manual receipt while a Stripe attempt may still collect money', async () => {
    const f = fixture(); f.pending();
    await expect(f.service.recordPayment(1, { requestKey: 'cb887a17-9b76-454c-a98c-8a7e03efedca', amount: 20, paymentMethod: 'CASH', fundsVerified: true }, admin)).rejects.toThrow('active Stripe');
  });

  it('confirms Stripe payments once and ignores duplicate or reordered failed events', async () => {
    const f = fixture(); f.pending(); f.stripe.checkout.sessions.retrieve.mockResolvedValue(f.session());
    const event: any = { type: 'checkout.session.completed', data: { object: f.session() } };
    await f.service.handleVerifiedStripeEvent(event);
    await f.service.handleVerifiedStripeEvent(event);
    await f.service.handleVerifiedStripeEvent({ ...event, type: 'checkout.session.async_payment_failed' });
    expect(f.sale.paidAmount.toFixed(2)).toBe('100.00');
    expect(f.payments[0].status).toBe('PAID');
    expect(f.db.materialPayment.update).toHaveBeenCalledTimes(1);
    expect(f.inventory.deliverSale).not.toHaveBeenCalled();
  });

  it.each([{ amount_total: 9900 }, { currency: 'eur' }, { metadata: { materialSaleId: '1', materialPaymentId: '12' } }])('rejects mismatched provider payment %#', async extra => {
    const f = fixture(); f.pending(); f.stripe.checkout.sessions.retrieve.mockResolvedValue(f.session(extra));
    await expect(f.service.handleVerifiedStripeEvent({ type: 'checkout.session.completed', data: { object: f.session() } } as any)).rejects.toThrow();
    expect(f.sale.paidAmount.eq(0)).toBe(true);
    expect(f.db.materialPayment.update).not.toHaveBeenCalled();
  });

  it('leaves preexisting estimate checkout events for PaymentsService', async () => {
    const f = fixture();
    expect(await f.service.handleVerifiedStripeEvent({ type: 'checkout.session.completed', data: { object: { metadata: { estimateId: '123' } } } } as any)).toBe(false);
    expect(f.stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it('reuses a durable checkout request after an unknown Stripe API response', async () => {
    const f = fixture();
    f.stripe.checkout.sessions.create.mockRejectedValueOnce(new Error('network timeout')).mockResolvedValueOnce(f.session({ status: 'open', payment_status: 'unpaid', payment_intent: null, url: 'https://checkout.stripe.test/session' }));
    await expect(f.service.checkoutForAdmin(1, admin)).rejects.toThrow('network timeout');
    expect(f.payments).toHaveLength(1);
    expect(f.payments[0].status).toBe('PENDING');
    await f.service.checkoutForAdmin(1, admin);
    expect(f.payments).toHaveLength(1);
    expect(f.stripe.checkout.sessions.create.mock.calls[0][1]).toEqual(f.stripe.checkout.sessions.create.mock.calls[1][1]);
  });

  it('preserves the confirmed intent when the webhook wins the checkout creation response race', async () => {
    const f = fixture();
    f.stripe.checkout.sessions.retrieve.mockResolvedValue(f.session());
    f.stripe.checkout.sessions.create.mockImplementation(async () => {
      await f.service.handleVerifiedStripeEvent({ type: 'checkout.session.completed', data: { object: f.session() } } as any);
      return f.session({ status: 'open', payment_status: 'unpaid', payment_intent: null, url: 'https://checkout.stripe.test/session' });
    });
    await f.service.checkoutForAdmin(1, admin);
    expect(f.payments[0].status).toBe('PAID');
    expect(f.payments[0].stripePaymentIntentId).toBe('pi_test');
    expect(f.payments[0].checkoutUrl).toBeNull();
  });

  it('recovers an old unknown Stripe response by paginated metadata lookup without creating another session', async () => {
    const f = fixture(); const payment = f.pending(); payment.stripeSessionId = null; payment.createdAt = new Date(Date.now() - 24 * 3600000);
    f.stripe.checkout.sessions.list.mockResolvedValueOnce({ data: [{ id: 'cs_unrelated', metadata: { estimateId: '123' } }], has_more: true }).mockResolvedValueOnce({ data: [f.session()], has_more: false });
    f.stripe.checkout.sessions.retrieve.mockResolvedValue(f.session());
    const result = await f.service.syncPaymentsForAdmin(1, admin);
    expect(result.paymentStatus).toBe('PAID');
    expect(payment.stripeSessionId).toBe('cs_test');
    expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    const calls = f.stripe.checkout.sessions.list.mock.calls;
    expect(calls[1][0].starting_after).toBe('cs_unrelated');
    expect(calls[0][0].created.gte).toBe(Math.floor(payment.createdAt.getTime() / 1000) - 300);
    expect(calls[0][0].created.lte - calls[0][0].created.gte).toBeLessThanOrEqual(23 * 3600 + 601);
  });

  it('closes an old orphan only after a complete empty search and allows a separate new checkout', async () => {
    const f = fixture(); const payment = f.pending(); payment.stripeSessionId = null; payment.createdAt = new Date(Date.now() - 24 * 3600000);
    f.stripe.checkout.sessions.list.mockResolvedValue({ data: [], has_more: false });
    await f.service.syncPaymentsForAdmin(1, admin);
    expect(payment.status).toBe('FAILED');
    expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    f.stripe.checkout.sessions.create.mockResolvedValue(f.session({ id: 'cs_new', metadata: { materialSaleId: '1', materialPaymentId: '12' }, status: 'open', payment_status: 'unpaid', payment_intent: null, url: 'https://checkout.stripe.test/new' }));
    await f.service.checkoutForAdmin(1, admin);
    expect(f.payments).toHaveLength(2);
    expect(f.payments[1].requestKey).not.toBe(payment.requestKey);
    expect(f.stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  it('keeps an orphan payment and reservation blocked when Stripe lookup fails', async () => {
    const f = fixture(); const payment = f.pending(); payment.stripeSessionId = null; payment.createdAt = new Date(Date.now() - 24 * 3600000);
    f.stripe.checkout.sessions.list.mockRejectedValue(new Error('provider unavailable'));
    await expect(f.service.syncPaymentsForAdmin(1, admin)).rejects.toThrow('provider unavailable');
    expect(payment.status).toBe('PENDING');
    expect(f.sale.status).toBe('CONFIRMED');
    expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it.each(['multiple', 'incomplete', 'mismatch'])('does not clear an orphan for an ambiguous %s lookup', async mode => {
    const f = fixture(); const payment = f.pending(); payment.stripeSessionId = null; payment.createdAt = new Date(Date.now() - 24 * 3600000);
    f.stripe.checkout.sessions.list.mockResolvedValue(mode === 'multiple' ? { data: [f.session(), f.session({ id: 'cs_other' })], has_more: false } : mode === 'incomplete' ? { data: [], has_more: true } : { data: [f.session()], has_more: false });
    f.stripe.checkout.sessions.retrieve.mockResolvedValue(f.session({ amount_total: 9999 }));
    await expect(f.service.syncPaymentsForAdmin(1, admin)).rejects.toThrow();
    expect(payment.status).toBe('PENDING');
    expect(payment.stripeSessionId).toBeNull();
    expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('does not allow operators to run payment recovery', async () => {
    const f = fixture();
    await expect(f.service.syncPaymentsForAdmin(1, { id: 3, role: { name: 'operator' } })).rejects.toThrow('Only administrators');
    expect(f.stripe.checkout.sessions.list).not.toHaveBeenCalled();
  });

  it('expires a checkout with Stripe before releasing its stock reservations', async () => {
    const f = fixture(); f.pending();
    f.stripe.checkout.sessions.retrieve.mockResolvedValue(f.session({ status: 'open', payment_status: 'unpaid' }));
    f.stripe.checkout.sessions.expire.mockResolvedValue(f.session({ status: 'expired', payment_status: 'unpaid' }));
    const result = await f.service.cancel(1, admin);
    expect(result.status).toBe('CANCELED');
    expect(f.payments[0].status).toBe('EXPIRED');
    expect(f.stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_test');
  });

  it('keeps the reservation when payment wins the cancellation race', async () => {
    const f = fixture(); f.pending();
    f.stripe.checkout.sessions.retrieve.mockResolvedValue(f.session());
    await expect(f.service.cancel(1, admin)).rejects.toThrow('Refund');
    expect(f.sale.status).toBe('CONFIRMED');
    expect(f.sale.paidAmount.toFixed(2)).toBe('100.00');
    expect(f.inventory.lockProducts).not.toHaveBeenCalled();
  });

  it('requires full payment and deducts stock only once on delivery', async () => {
    const f = fixture();
    await expect(f.service.deliver(1, requestKey, admin)).rejects.toThrow('Full payment');
    expect(f.inventory.deliverSale).not.toHaveBeenCalled();
    f.sale.paidAmount = D(100);
    await f.service.deliver(1, requestKey, admin);
    await f.service.deliver(1, requestKey, admin);
    expect(f.inventory.deliverSale).toHaveBeenCalledTimes(1);
    expect(f.sale.status).toBe('DELIVERED');
  });

  it('records dashboard refunds without restoring physical stock or double counting', async () => {
    const f = fixture(); const payment = f.pending(); payment.status = 'PAID'; payment.stripePaymentIntentId = 'pi_test'; f.sale.paidAmount = D(100);
    f.db.materialPayment.findFirst.mockResolvedValue(payment);
    f.stripe.charges.retrieve.mockResolvedValue({ id: 'ch_test', payment_intent: 'pi_test', currency: 'usd', amount: 10000, amount_refunded: 2500 });
    f.stripe.refunds.list.mockResolvedValue({ data: [{ id: 're_test', amount: 2500, currency: 'usd', status: 'succeeded' }, { id: 're_failed', amount: 1000, currency: 'usd', status: 'failed' }, { id: 're_pending', amount: 1000, currency: 'usd', status: 'pending' }], has_more: false });
    const event: any = { type: 'charge.refunded', data: { object: { object: 'charge', id: 'ch_test' } } };
    await f.service.handleVerifiedStripeEvent(event);
    await f.service.handleVerifiedStripeEvent(event);
    expect(f.sale.paidAmount.toFixed(2)).toBe('75.00');
    expect(f.inventory.deliverSale).not.toHaveBeenCalled();
  });

  it('uses global tax and price snapshots for an online cart allocated across Stores', async () => {
    const f = fixture();
    const p = { id: 1, productId: 1, isBase: true, isActive: true, isSaleEnabled: true, multiplier: 1, name: 'Tube', salePrice: D(1), product: { id: 1, name: 'Caulking', code: 'MAT-1', isActive: true, isSaleEnabled: true } };
    f.db.materialPresentation.findMany.mockResolvedValue([p]);
    f.db.warehouseStore.findMany.mockResolvedValue([{ id: 1, isActive: true }, { id: 2, isActive: true }]);
    f.inventory.loadStock.mockImplementation(async (_tx, _product, storeId) => ({ basePresentationId: 1, packs: [{ id: 1, baseUnits: 1, quantity: storeId === 1 ? 2 : 3 }], reservations: [] }));
    const result = await f.service.createCustomerOrder({ requestKey, lines: [{ presentationId: 1, quantity: 5 }] }, customer);
    expect(result.total).toBe('5.35');
    expect(result.taxRate).toBe('7');
    expect(result.lines.map(l => l.quantity)).toEqual([2, 3]);
    expect(result.lines.every(l => !('storeId' in l))).toBe(true);
    expect(result.status).toBe('CONFIRMED');
    expect(f.inventory.deliverSale).not.toHaveBeenCalled();
    expect(f.db.materialSale.create.mock.calls[0][0].data.requireFullPayment).toBe(true);
  });

  it('does not release a paid account order during expiration cleanup', async () => {
    const f = fixture(); f.sale.expiresAt = new Date(0); f.sale.paidAmount = D(1);
    f.db.materialSale.findMany.mockResolvedValue([{ id: 1 }]);
    await f.service.expireUnpaidOnlineOrders();
    expect(f.sale.status).toBe('CONFIRMED');
    expect(f.db.materialSale.update).not.toHaveBeenCalled();
  });

  it.each([undefined, { id: 4, role: { name: 'technician' } }])('blocks unauthenticated or technician shopping before accessing inventory', async actor => {
    const f = cartFixture();
    await expect(f.service.customerCatalog(actor as any)).rejects.toThrow('authorized account');
    await expect(f.service.createCustomerOrder(f.cart, actor as any)).rejects.toThrow('authorized account');
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.inventory.operation).not.toHaveBeenCalled();
  });

  it.each(['admin', 'operator'] as const)('blocks implicit %s checkout before looking up accounts or mutating stock', async role => {
    const f = cartFixture();
    await expect(f.service.createCustomerOrder(f.cart, { id: 9, role: { name: role } })).rejects.toThrow('select a customer');
    expect(f.db.user.findUnique).not.toHaveBeenCalled();
    expect(f.inventory.operation).not.toHaveBeenCalled();
    expect(f.inventory.lockProducts).not.toHaveBeenCalled();
    expect(f.db.materialSale.create).not.toHaveBeenCalled();
    expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it.each(['client', 'dealer'] as const)('creates a %s account order using that buyer identity', async role => {
    const f = cartFixture();
    f.db.user.findUnique.mockResolvedValue({ id: customer.id, username: 'buyer', firstName: 'Account', lastName: 'Buyer', email: 'ACCOUNT@example.test', phone: null, isActive: true, deletedAt: null, role: { name: role } });
    await expect(f.service.createCustomerOrder(f.cart, { ...customer, role: { name: role } })).resolves.toMatchObject({ status: 'CONFIRMED', total: '2.14' });
    expect(f.db.materialSale.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ customerUserId: customer.id, createdById: customer.id }) }));
  });

  it('snapshots persisted account data and ignores spoofed names, contact details and account IDs', async () => {
    const f = cartFixture();
    const result = await f.service.createCustomerOrder({ ...f.cart, customerName: 'Spoof', customerEmail: 'spoof@example.test', customerPhone: 'wrong', createdById: 99, userId: 99 } as any, { ...customer, firstName: 'Stale', email: 'stale@example.test' });
    expect(result).toMatchObject({ customerName: 'Account Buyer', customerEmail: 'account@example.test', customerPhone: '555-0100' });
    expect(f.db.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: customer.id } }));
    expect(f.db.materialSale.create.mock.calls[0][0].data.createdById).toBe(customer.id);
    expect(f.db.materialSale.create.mock.calls[0][0].data.customerUserId).toBe(customer.id);
    expect(f.inventory.operation).toHaveBeenCalledWith(requestKey, f.cart, customer.id, 'CUSTOMER_SALE_CREATE', expect.any(Function));
    expect(f.db.materialSale.count).toHaveBeenCalledWith({ where: { customerUserId: customer.id, expiresAt: { not: null }, status: 'CONFIRMED', paidAmount: 0 } });
  });

  it('uses the account username when names are blank and permits accounts without email or phone', async () => {
    const f = cartFixture();
    f.db.user.findUnique.mockResolvedValue({ id: customer.id, username: 'buyer', firstName: ' ', lastName: '', email: null, phone: null, isActive: true, deletedAt: null, role: { name: 'client' } });
    await expect(f.service.createCustomerOrder(f.cart, customer)).resolves.toMatchObject({ customerName: 'buyer', customerEmail: null, customerPhone: null });
  });

  it('fits valid maximum-length account names into the sale snapshot', async () => {
    const f = cartFixture();
    f.db.user.findUnique.mockResolvedValue({ id: customer.id, username: 'buyer', firstName: 'A'.repeat(100), lastName: 'B'.repeat(100), email: null, phone: null, isActive: true, deletedAt: null, role: { name: 'client' } });
    const result = await f.service.createCustomerOrder(f.cart, customer);
    expect(result.customerName).toBe(`${'A'.repeat(100)} ${'B'.repeat(99)}`);
    expect(result.customerName).toHaveLength(200);
  });

  it.each([null, { isActive: false }, { deletedAt: new Date() }, { role: { name: 'technician' } }, { role: { name: 'admin' } }, { role: { name: 'operator' } }])('rejects unavailable or unauthorized persisted accounts', async patch => {
    const f = cartFixture();
    f.db.user.findUnique.mockResolvedValue(patch === null ? null : { isActive: true, deletedAt: null, role: { name: 'client' }, ...patch });
    await expect(f.service.createCustomerOrder(f.cart, customer)).rejects.toThrow('cannot place');
    expect(f.inventory.operation).not.toHaveBeenCalled();
    expect(f.inventory.lockProducts).not.toHaveBeenCalled();
    expect(f.db.materialOperation.create).not.toHaveBeenCalled();
    expect(f.db.materialSale.create).not.toHaveBeenCalled();
  });

  it('enforces the pending-order limit for the account rather than a supplied email', async () => {
    const f = cartFixture(); f.db.materialSale.count.mockResolvedValue(5);
    await expect(f.service.createCustomerOrder(f.cart, customer)).rejects.toThrow('pending material orders');
    expect(f.db.materialSale.create).not.toHaveBeenCalled();
  });

  it('replays the original account order after profile edits and refuses the same key for another account', async () => {
    const f = cartFixture();
    const operations = new Map<string, any>();
    f.db.materialOperation = {
      findUnique: jest.fn(async ({ where }) => operations.get(where.requestKey)),
      create: jest.fn(async ({ data }) => { operations.set(data.requestKey, data); return data; }),
      update: jest.fn(async ({ where, data }) => Object.assign(operations.get(where.requestKey), data)),
    };
    const inventory = new MaterialsInventoryService(f.db);
    f.inventory.operation.mockImplementation(inventory.operation.bind(inventory));
    const first = await f.service.createCustomerOrder(f.cart, customer);
    f.db.user.findUnique.mockResolvedValue({ id: customer.id, username: 'edited', firstName: 'New', lastName: 'Profile', email: 'edited@example.test', phone: null, isActive: true, deletedAt: null, role: { name: 'client' } });
    const second = await f.service.createCustomerOrder(f.cart, customer);
    expect(second).toEqual({ ...first, replayed: true });
    expect(second.customerName).toBe('Account Buyer');
    expect(f.db.user.findUnique).toHaveBeenCalledTimes(2);
    expect(f.db.materialSale.create).toHaveBeenCalledTimes(1);
    expect(operations.get(requestKey).actorId).toBe(customer.id);
    await expect(f.service.createCustomerOrder(f.cart, { ...customer, id: 8 })).rejects.toThrow('already used');
  });

  it('rechecks the persisted buyer role before replaying an existing customer checkout', async () => {
    const f = cartFixture();
    f.db.materialOperation.update = jest.fn(async ({ where, data }) => Object.assign(f.operations.get(where.requestKey), data));
    const inventory = new MaterialsInventoryService(f.db);
    f.inventory.operation.mockImplementation(inventory.operation.bind(inventory));
    await f.service.createCustomerOrder(f.cart, customer);
    f.db.user.findUnique.mockResolvedValue({ id: customer.id, isActive: true, deletedAt: null, role: { name: 'admin' } });
    await expect(f.service.createCustomerOrder(f.cart, customer)).rejects.toThrow('cannot place');
    expect(f.inventory.operation).toHaveBeenCalledTimes(1);
    expect(f.db.materialOperation.create).toHaveBeenCalledTimes(1);
    expect(f.db.materialSale.create).toHaveBeenCalledTimes(1);
  });

  it.each([customer.id, null])('expires unpaid online orders regardless of whether an account created them', async createdById => {
    const f = fixture(); f.sale.createdById = createdById; f.sale.expiresAt = new Date(0);
    await f.service.expireUnpaidOnlineOrders();
    expect(f.sale.status).toBe('CANCELED');
    expect(f.db.materialSale.findMany.mock.calls[0][0].where).not.toHaveProperty('createdById');
  });

  it('preserves staff sales with no expiry and online orders whose Stripe status is uncertain', async () => {
    const staff = fixture();
    await staff.service.expireUnpaidOnlineOrders();
    expect(staff.sale.status).toBe('CONFIRMED');
    const online = fixture(); online.sale.expiresAt = new Date(0); online.pending();
    online.stripe.checkout.sessions.retrieve.mockRejectedValue(new Error('Unavailable'));
    await online.service.expireUnpaidOnlineOrders();
    expect(online.sale.status).toBe('CONFIRMED');
    expect(online.db.materialSale.update).not.toHaveBeenCalled();
  });

  it('prevents payment checkout after an account reservation expires', async () => {
    const f = fixture(); f.sale.expiresAt = new Date(0);
    await expect(f.service.checkoutForPublic(f.sale.publicToken)).rejects.toThrow('reservation has expired');
    expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(f.db.materialPayment.create).not.toHaveBeenCalled();
  });
});
