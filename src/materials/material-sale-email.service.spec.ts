import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MaterialSaleEmailService } from './material-sale-email.service';

function fixture() {
  const row = {
    id: 10, saleId: 21, email: 'guest@example.com', customerName: 'Guest Buyer',
    saleCode: 'MS-123', total: new Prisma.Decimal('48.15'), currency: 'USD', publicToken: 'a'.repeat(64),
    status: 'PENDING', attempts: 0, attemptedAt: null as Date | null,
    nextAttemptAt: new Date(), acceptedAt: null as Date | null,
    providerMessageId: null as string | null, errorCode: null as string | null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const sale = {
    id: 21, customerUserId: null as number | null, customerName: row.customerName,
    customerEmail: row.email as string | null, code: row.saleCode, currency: row.currency,
    total: new Prisma.Decimal('48.15'), paidAmount: new Prisma.Decimal('48.15'),
    publicToken: row.publicToken, status: 'CONFIRMED',
  };
  const matches = (where: any) =>
    (!where.status || where.status === row.status) &&
    (!where.id || where.id === row.id) &&
    (where.attempts === undefined || where.attempts === row.attempts) &&
    (!where.nextAttemptAt?.lte || row.nextAttemptAt <= where.nextAttemptAt.lte) &&
    (!where.createdAt?.lt || row.createdAt < where.createdAt.lt) &&
    (!where.attemptedAt?.lt || Boolean(row.attemptedAt && row.attemptedAt < where.attemptedAt.lt));
  const queuedSales = new Set<number>();
  const db = {
    materialSale: { findUnique: jest.fn().mockResolvedValue(sale) },
    materialSaleEmail: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const item of data) {
          if (skipDuplicates && queuedSales.has(item.saleId)) continue;
          queuedSales.add(item.saleId); count += 1;
        }
        return { count };
      }),
      findMany: jest.fn(async ({ where }: any) => matches(where) ? [{ ...row }] : []),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!matches(where)) return { count: 0 };
        const { attempts, ...rest } = data;
        Object.assign(row, rest);
        if (attempts?.increment) row.attempts += attempts.increment;
        if (attempts?.decrement) row.attempts -= attempts.decrement;
        return { count: 1 };
      }),
    },
  };
  const emails = {
    canSendMaterialPurchaseEmail: jest.fn().mockReturnValue(true),
    sendMaterialPurchaseEmail: jest.fn().mockResolvedValue({ status: 'ACCEPTED', providerMessageId: '<receipt-id>' }),
  };
  const createService = () => new MaterialSaleEmailService(db as never, emails as never);
  return { row, sale, db, emails, queuedSales, createService, service: createService() };
}

describe('MaterialSaleEmailService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-12T18:00:00Z'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('durably snapshots the guest receipt in the supplied payment transaction without SMTP or account lookup', async () => {
    const f = fixture(); f.emails.canSendMaterialPurchaseEmail.mockReturnValue(false);
    f.sale.customerEmail = ' GUEST@example.com ';
    await f.service.enqueue(f.sale, f.db as never);
    await f.service.enqueue(f.sale, f.db as never);
    expect(f.db.materialSaleEmail.createMany).toHaveBeenCalledWith({
      data: [{ saleId: 21, email: 'guest@example.com', customerName: 'Guest Buyer', saleCode: 'MS-123', total: f.sale.total, currency: 'USD', publicToken: f.sale.publicToken }],
      skipDuplicates: true,
    });
    expect([...f.queuedSales]).toEqual([21]);
    expect(f.emails.canSendMaterialPurchaseEmail).not.toHaveBeenCalled();
    expect(f.emails.sendMaterialPurchaseEmail).not.toHaveBeenCalled();
    expect(f.db.materialSale.findUnique).not.toHaveBeenCalled();
  });

  it.each([null, '', 'invalid', 'guest@example.com\r\nBcc: other@example.com'])('does not queue a missing or invalid manual email: %s', async customerEmail => {
    const f = fixture(); f.sale.customerEmail = customerEmail;
    await f.service.enqueue(f.sale, f.db as never);
    expect(f.db.materialSaleEmail.createMany).not.toHaveBeenCalled();
  });

  it('sends one invoice link without requiring or creating an account', async () => {
    const f = fixture();
    await f.service.processPending();
    expect(f.emails.sendMaterialPurchaseEmail).toHaveBeenCalledWith({
      to: 'guest@example.com', customerName: 'Guest Buyer', saleCode: 'MS-123',
      total: '48.15', currency: 'USD', path: `/public/material-sales/${'a'.repeat(64)}`,
    });
    expect(f.row).toMatchObject({ status: 'ACCEPTED', attempts: 1, providerMessageId: '<receipt-id>', acceptedAt: new Date() });
    await f.service.processPending();
    expect(f.emails.sendMaterialPurchaseEmail).toHaveBeenCalledTimes(1);
  });

  it('allows only one worker to claim a pending receipt', async () => {
    const f = fixture();
    await Promise.all([f.service.processPending(), f.createService().processPending()]);
    expect(f.emails.sendMaterialPurchaseEmail).toHaveBeenCalledTimes(1);
    expect(f.row.attempts).toBe(1);
  });

  it.each(['email', 'account', 'name', 'token', 'code', 'currency', 'total', 'missing'])(
    'does not send a stale bearer invoice after the purchase %s changes', async change => {
      const f = fixture();
      if (change === 'email') f.sale.customerEmail = 'new@example.com';
      if (change === 'account') f.sale.customerUserId = 99;
      if (change === 'name') f.sale.customerName = 'Different Buyer';
      if (change === 'token') f.sale.publicToken = 'b'.repeat(64);
      if (change === 'code') f.sale.code = 'MS-OTHER';
      if (change === 'currency') f.sale.currency = 'EUR';
      if (change === 'total') f.sale.total = new Prisma.Decimal(10);
      if (change === 'missing') f.db.materialSale.findUnique.mockResolvedValue(null);
      await f.service.processPending();
      expect(f.row).toMatchObject({ status: 'SKIPPED', errorCode: 'PURCHASE_CHANGED' });
      expect(f.emails.sendMaterialPurchaseEmail).not.toHaveBeenCalled();
    },
  );

  it.each(['CANCELED', 'DRAFT', 'PARTIAL', 'ZERO', 'REFUNDED'])('does not claim that a %s purchase is paid', async status => {
    const f = fixture();
    if (['CANCELED', 'DRAFT'].includes(status)) f.sale.status = status;
    else if (status === 'ZERO') { f.sale.total = new Prisma.Decimal(0); f.row.total = new Prisma.Decimal(0); }
    else f.sale.paidAmount = new Prisma.Decimal(status === 'PARTIAL' ? 10 : 0);
    await f.service.processPending();
    expect(f.row).toMatchObject({ status: 'SKIPPED', errorCode: 'PURCHASE_NOT_PAID' });
    expect(f.emails.sendMaterialPurchaseEmail).not.toHaveBeenCalled();
  });

  it('still sends the receipt if pickup was completed before the worker ran', async () => {
    const f = fixture(); f.sale.status = 'DELIVERED';
    await f.service.processPending();
    expect(f.row.status).toBe('ACCEPTED');
  });

  it('retries explicit temporary rejection with backoff and a three-attempt bound', async () => {
    const f = fixture(); f.emails.sendMaterialPurchaseEmail.mockResolvedValue({ status: 'RETRY', errorCode: 'SMTP_451' });
    await f.service.processPending();
    expect(f.row).toMatchObject({ status: 'PENDING', attempts: 1, errorCode: 'SMTP_451' });
    expect(f.row.nextAttemptAt).toEqual(new Date(Date.now() + 60_000));
    await f.service.processPending();
    expect(f.emails.sendMaterialPurchaseEmail).toHaveBeenCalledTimes(1);
    jest.setSystemTime(f.row.nextAttemptAt);
    await f.service.processPending();
    expect(f.row.nextAttemptAt).toEqual(new Date(Date.now() + 120_000));
    jest.setSystemTime(f.row.nextAttemptAt);
    await f.service.processPending();
    await f.service.processPending();
    expect(f.row).toMatchObject({ status: 'FAILED', attempts: 3, errorCode: 'SMTP_451' });
    expect(f.emails.sendMaterialPurchaseEmail).toHaveBeenCalledTimes(3);
  });

  it.each(['FAILED', 'UNKNOWN'])('does not retry a %s SMTP result', async status => {
    const f = fixture(); f.emails.sendMaterialPurchaseEmail.mockResolvedValue({ status, errorCode: 'SAFE_ERROR' });
    await f.service.processPending(); await f.service.processPending();
    expect(f.row.status).toBe(status);
    expect(f.emails.sendMaterialPurchaseEmail).toHaveBeenCalledTimes(1);
  });

  it('does not claim pending rows while notification email settings are unavailable', async () => {
    const f = fixture(); f.emails.canSendMaterialPurchaseEmail.mockReturnValue(false);
    await f.service.processPending();
    expect(f.row.status).toBe('PENDING');
    expect(f.db.materialSaleEmail.updateMany).not.toHaveBeenCalled();
    expect(f.emails.sendMaterialPurchaseEmail).not.toHaveBeenCalled();
  });

  it('defers a settings race without consuming a send attempt', async () => {
    const f = fixture(); f.emails.sendMaterialPurchaseEmail.mockResolvedValue({ status: 'UNAVAILABLE', errorCode: 'EMAIL_NOT_CONFIGURED' });
    await f.service.processPending();
    expect(f.row).toMatchObject({ status: 'PENDING', attempts: 0, errorCode: 'EMAIL_NOT_CONFIGURED' });
    expect(f.row.nextAttemptAt).toEqual(new Date(Date.now() + 60_000));
  });

  it.each(['expired', 'interrupted'])('never sends an %s entry', async state => {
    const f = fixture();
    if (state === 'expired') f.row.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    else { f.row.status = 'SENDING'; f.row.attemptedAt = new Date(Date.now() - 11 * 60 * 1000); }
    await f.service.processPending();
    expect(f.row.status).toBe(state === 'expired' ? 'SKIPPED' : 'UNKNOWN');
    expect(f.emails.sendMaterialPurchaseEmail).not.toHaveBeenCalled();
  });

  it('does not resend when SMTP accepted but saving the acceptance failed', async () => {
    const f = fixture();
    const update = f.db.materialSaleEmail.updateMany.getMockImplementation()!;
    f.db.materialSaleEmail.updateMany.mockImplementation(async args => {
      if (args.data.status === 'ACCEPTED') throw new Error('private database failure');
      return update(args);
    });
    await f.service.processPending();
    expect(f.row.status).toBe('SENDING');
    jest.setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
    await f.service.processPending();
    expect(f.row).toMatchObject({ status: 'UNKNOWN', errorCode: 'INTERRUPTED_ATTEMPT' });
    expect(f.emails.sendMaterialPurchaseEmail).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(jest.mocked(Logger.prototype.error).mock.calls)).not.toMatch(/private database failure|guest@example.com/);
  });
});
