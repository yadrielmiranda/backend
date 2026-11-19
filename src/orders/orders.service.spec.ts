import { Prisma } from '@prisma/client';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { OrdersService } from './orders.service';

describe('OrdersService', () => {
  it.each([
    ['0.07', false, '7.00'], ['0.07', true, '0.00'], [null, false, '8.00'],
  ] as const)('taxes eligible extra charges using the root dealer rate %s and exemption %s', async (rate, isTaxExempt, tax) => {
    const tx = {
      order: { findUnique: jest.fn().mockResolvedValue({
        status: { name: 'Delivered' },
        user: { dealerMode: 'EXTERNAL', parentDealerId: null, networkTaxRate: rate, isTaxExempt },
        estimate: { paymentPlanSnapshot: {}, installationJob: { status: 'COMPLETED', quotes: [{}], payments: [] } },
      }) },
      globalParameter: { findUnique: jest.fn().mockResolvedValue({ value: new Prisma.Decimal('.08') }) },
      orderExtraCharge: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }) => ({ ...data, id: 12 })),
      },
    };
    const db = { $transaction: (work) => work(tx), order: { findUniqueOrThrow: jest.fn().mockResolvedValue({ userId: 2, number: '123' }) } };
    const service = new OrdersService(db as never, { createAndSend: jest.fn() } as never, { log: jest.fn() } as never, {} as never);
    const charge = await service.createExtraCharge(1, { lines: [
      { description: 'Material', quantity: 1, unitPrice: 100, taxable: true },
      { description: 'Labor', quantity: 1, unitPrice: 50, taxable: false },
    ] }, { id: 1, role: { name: 'admin' } } as AuthUser);
    expect(charge.taxAmount.toFixed(2)).toBe(tax);
  });
});
