import { ConflictException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma, FactoryPaymentKind } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import { FactoryPaymentsController } from './factory-payments.controller';
import { FactoryPaymentsService, factoryPaymentRow } from './factory-payments.service';
import { CreateFactoryPaymentDto, FactoryPaymentStatus } from './factory-payments.dto';
import { factoryBalance, importedFactoryTotal, paymentAmount, paymentDate } from './factory-payments-values';

const dec = (value: string) => new Prisma.Decimal(value);
const request = (): CreateFactoryPaymentDto => ({
  manufacturerId: 1, amount: '1162.63', paidOn: '2026-11-09', invoiceNumber: '296383-D',
  kind: FactoryPaymentKind.DEPOSIT, requestId: '372c5a14-7596-4a81-98e6-828451e01025',
});
const source = (): any => ({
  id: 1, number: 'ORD-1', date: new Date('2026-11-09'), poNumber: '296383', rateReal: dec('2325.25500000'),
  estimate: { name: 'Test project', pieces: [{ id: 1 }] }, factoryPaymentAccount: null,
});
const account = (): any => ({
  id: 10, orderId: 1, manufacturerId: 1, poNumber: '296383', sourceCost: dec('2325.25500000'),
  total: dec('2325.26'), version: 2, manufacturer: { id: 1, name: 'Eco Window Systems' }, payments: [],
});

function serviceWith(order = source()) {
  const db: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    order: { findUnique: jest.fn().mockResolvedValue(order) },
    factoryManufacturer: { findUnique: jest.fn().mockResolvedValue({ id: 1, active: true }) },
    factoryPayment: {
      findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 90 }),
      update: jest.fn().mockResolvedValue({ id: 90 }),
    },
    factoryPaymentAccount: { create: jest.fn().mockResolvedValue(account()), update: jest.fn().mockResolvedValue(account()) },
    factoryPaymentEvent: { create: jest.fn().mockResolvedValue({ id: 1 }) },
  };
  db.$transaction = jest.fn((run) => run(db));
  const service = new FactoryPaymentsService(db);
  jest.spyOn(service, 'detail').mockResolvedValue({ order: {} as any, payments: [], events: [] });
  return { db, service, order };
}

describe('Factory payment amounts and balances', () => {
  it('uses only exact Amount cents and rounds the imported cost once, half up', () => {
    expect(importedFactoryTotal(dec('2325.25500000'))!.toFixed(2)).toBe('2325.26');
    const balance = factoryBalance(dec('2325.26'), [paymentAmount('1162.63'), paymentAmount('1162.63')]);
    expect(balance.paid.toFixed(2)).toBe('2325.26');
    expect(balance.remaining!.toFixed(2)).toBe('0.00');
  });
  it('keeps unknown amounts unknown and displays overpayments as credits', () => {
    expect(importedFactoryTotal(null)).toBeNull();
    expect(factoryBalance(null, []).remaining).toBeNull();
    expect(factoryBalance(dec('40000'), [dec('21001.27'), dec('20000')]).remaining!.toFixed(2)).toBe('-1001.27');
  });
  it.each(['0', '-1', 'NaN', '1.123', '1e3', '10000000000', '1,000.00'])('rejects invalid payment amount %s', value => {
    expect(() => paymentAmount(value)).toThrow();
  });
  it.each(['2026-02-30', '2026-13-01', '0001-01-01', 'invalid'])('rejects invalid date %s', value => {
    expect(() => paymentDate(value)).toThrow();
  });
  it('preserves valid calendar dates without local timezone shifts', () => {
    expect(paymentDate('2024-02-29').toISOString()).toBe('2024-02-29T00:00:00.000Z');
  });
  it('validates a numeric string amount, full invoice and known payment kind', async () => {
    expect(await validate(plainToInstance(CreateFactoryPaymentDto, request()))).toHaveLength(0);
    expect((await validate(plainToInstance(CreateFactoryPaymentDto, { ...request(), amount: 50 }))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(CreateFactoryPaymentDto, { ...request(), kind: 'FP' }))).length).toBeGreaterThan(0);
  });
});

describe('Factory payment status', () => {
  it('requires JSON unit links, not just a PO and cost, and never substitutes the customer total', () => {
    const order = source();
    order.estimate.pieces = [];
    order.amount = dec('9999');
    const row = factoryPaymentRow(order);
    expect(row).toMatchObject({ imported: false, status: FactoryPaymentStatus.PENDING_IMPORT, factoryTotal: null, remaining: null });
  });
  it('excludes voided amounts and does not treat a FINAL concept as paid', () => {
    const order = source();
    order.factoryPaymentAccount = account();
    order.factoryPaymentAccount.payments = [
      { amount: dec('100'), voidedAt: null, kind: 'FINAL' },
      { amount: dec('2225.26'), voidedAt: new Date() },
    ];
    expect(factoryPaymentRow(order)).toMatchObject({ paid: '100.00', remaining: '2225.26', status: FactoryPaymentStatus.PARTIAL });
  });
  it('preserves the tracked total and reports a reimported cost change', () => {
    const order = source();
    order.factoryPaymentAccount = account();
    order.rateReal = dec('2500.125');
    expect(factoryPaymentRow(order)).toMatchObject({ factoryTotal: '2325.26', importedTotal: '2500.13', sourceCostChanged: true });
  });
});

describe('Factory payment mutations', () => {
  it('blocks payment before a real import, without creating any account or payment', async () => {
    const { db, service, order } = serviceWith();
    order.estimate.pieces = [];
    await expect(service.addPayment(1, request(), 1)).rejects.toThrow('Import this order');
    expect(db.factoryPayment.create).not.toHaveBeenCalled();
    expect(db.factoryPaymentAccount.create).not.toHaveBeenCalled();
  });
  it('records payment only in its own ledger, without touching operational source models', async () => {
    const { db, service } = serviceWith();
    await service.addPayment(1, request(), 7);
    expect(db.factoryPayment.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      amount: dec('1162.63'), invoiceNumber: '296383-D', createdById: 7,
    }) });
    expect(db.order).toEqual({ findUnique: expect.any(Function) });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'ReadCommitted' }));
  });
  it('returns the saved request on retry and rejects reuse with different details', async () => {
    const { db, service } = serviceWith();
    db.factoryPayment.findUnique.mockResolvedValue({ ...request(), account: { orderId: 1, manufacturerId: 1 }, amount: dec('1162.63'), paidOn: paymentDate('2026-11-09') });
    await service.addPayment(1, request(), 7);
    expect(db.factoryPayment.create).not.toHaveBeenCalled();
    await expect(service.addPayment(1, { ...request(), manufacturerId: 2 }, 7)).rejects.toThrow(ConflictException);
    await expect(service.addPayment(1, { ...request(), amount: '100' }, 7)).rejects.toThrow(ConflictException);
  });
  it('rejects stale versions and cost changes before recording another payment', async () => {
    const { db, service, order } = serviceWith();
    order.factoryPaymentAccount = account();
    await expect(service.addPayment(1, { ...request(), version: 1 }, 7)).rejects.toThrow('another session');
    order.rateReal = dec('2500');
    await expect(service.addPayment(1, { ...request(), version: 2 }, 7)).rejects.toThrow('factory cost changed');
    expect(db.factoryPayment.create).not.toHaveBeenCalled();
  });
  it('syncs only the independent control total with an audit record', async () => {
    const { db, service, order } = serviceWith();
    order.factoryPaymentAccount = account();
    order.rateReal = dec('2500.125');
    await service.syncTotal(1, 2, 7);
    expect(db.factoryPaymentAccount.update).toHaveBeenCalledWith({ where: { id: 10 }, data: { sourceCost: dec('2500.125'), total: dec('2500.13'), version: { increment: 1 } } });
    expect(db.factoryPaymentEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'TOTAL_SYNCED', actorId: 7 }) });
    expect(db.factoryPayment.update).not.toHaveBeenCalled();
  });
  it('voids without erasing the payment, preserving reason and idempotency', async () => {
    const { db, service } = serviceWith();
    const record = { id: 90, accountId: 10, account: { orderId: 1 }, amount: dec('1162.63'), invoiceNumber: '296383-D', voidedAt: null };
    db.factoryPayment.findUnique.mockResolvedValue(record);
    await service.voidPayment(90, 'Duplicate entry', 7);
    expect(db.factoryPayment.update).toHaveBeenCalledWith({ where: { id: 90 }, data: { voidedAt: expect.any(Date), voidedById: 7, voidReason: 'Duplicate entry' } });
    db.factoryPayment.update.mockClear();
    db.factoryPayment.findUnique.mockResolvedValue({ ...record, voidedAt: new Date() });
    await service.voidPayment(90, 'Duplicate entry', 7);
    expect(db.factoryPayment.update).not.toHaveBeenCalled();
  });
});

describe('Factory payments admin boundary', () => {
  it.each(['manufacturers', 'createManufacturer', 'updateManufacturer', 'list', 'detail', 'saveAccount', 'syncTotal', 'addPayment', 'voidPayment'])('%s only allows admin', method => {
    for (const role of ['admin', 'operator', 'dealer', 'client', 'technician', undefined]) {
      const allowed = new RolesGuard(new Reflector()).canActivate({
        getHandler: () => FactoryPaymentsController.prototype[method], getClass: () => FactoryPaymentsController,
        switchToHttp: () => ({ getRequest: () => ({ user: role ? { id: 1, role: { name: role } } : undefined }) }),
      } as any);
      expect(allowed).toBe(role === 'admin');
    }
  });
});
