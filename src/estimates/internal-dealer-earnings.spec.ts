import { Prisma } from '@prisma/client';
import { LogsService } from '@/logs/logs.service';
import { EstimatesService } from './estimates.service';
import { EstimatePieceCalculatorService } from './calculation/estimate-piece-calculator.service';

describe('Earnings conditions on a new estimate', () => {
  it.each(['INTERNAL', 'EXTERNAL'] as const)('creates a %s estimate and preserves the conditions selected at creation', async mode => {
    const user = {
      id: 7, isTaxExempt: false, markupOverride: null,
      dealerMode: mode, role: { name: 'dealer', markup: new Prisma.Decimal('.2') },
      dealerEarningsPlanId: 15,
    };
    const plan = { id: 15, name: 'Sales team A', revision: 3, basis: 'EXPECTED_PROFIT', percent: new Prisma.Decimal('25'), isActive: true };
    let saved: any;
    const db: any = {
      $queryRaw: jest.fn(async strings => strings.join(' ').includes('FROM DealerEarningsPlan')
        ? [{ ...plan }] : []),
      user: {
        findUnique: jest.fn(async () => user),
        findUniqueOrThrow: jest.fn(async () => user),
      },
      globalParameter: { findUnique: jest.fn(async ({ where }) => ({ value: where.key === 'SALES_TAX' ? '.07' : '30' })) },
      estimateStatus: { findUnique: jest.fn(async () => ({ id: 1 })) },
      estimateSequence: { create: jest.fn(async () => ({ id: 1 })) },
      estimate: {
        create: jest.fn(async ({ data }) => {
          saved = { ...data, id: 1, idUser: 7, status: { name: 'Active' }, user, pieces: [], payments: [], order: null, installationJob: null };
          return { id: 1 };
        }),
        findUnique: jest.fn(async () => saved),
      },
      eventLog: { create: jest.fn(async ({ data }) => ({ id: 81, ...data })) },
      tempLog: { create: jest.fn(async ({ data }) => ({ id: 82, ...data })) },
    };
    const prisma: any = { $transaction: jest.fn(async work => work(db)) };
    const logs = new LogsService(prisma);
    const calculator = new EstimatePieceCalculatorService({} as any, {} as any);
    const service = new EstimatesService(prisma, logs, {} as any, {} as any, calculator, {} as any, {} as any, {} as any, {} as any);
    const created = await service.createEmptyEstimate({ name: 'Test earnings' }, 7);
    // La auditoría debe confirmarse con el estimado, sin otra transacción que espere el bloqueo del usuario.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(db.eventLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: 'CREATE', entityType: 'Estimate', entityId: 1, userId: 7,
    }) });
    expect(db.tempLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      eventId: 81, after: expect.objectContaining({
        dealerEarningsPlanSnapshot: saved.dealerEarningsPlanSnapshot ?? null,
      }),
    }) });
    if (mode === 'INTERNAL') {
      expect(saved.dealerEarningsPlanSnapshot).toEqual({ version: 2, planId: 15, name: 'Sales team A', revision: 3, basis: 'EXPECTED_PROFIT', percent: '25' });
      expect(created.dealerEarnings).toMatchObject({ amount: '0.00', status: 'CALCULATED', percent: '25', planName: 'Sales team A' });
      plan.percent = new Prisma.Decimal(30);
      plan.revision++;
      const next = await service.createEmptyEstimate({ name: 'After changing the plan' }, 7);
      expect(next.dealerEarningsPlanSnapshot).toMatchObject({ planId: 15, percent: '30', revision: 4 });
      expect(created.dealerEarningsPlanSnapshot).toMatchObject({ planId: 15, percent: '25', revision: 3 });
    } else {
      expect(saved).not.toHaveProperty('dealerEarningsPlanSnapshot');
      expect(created.dealerEarnings).toBeNull();
    }
    expect(created.priceT.toString()).toBe('0');
    expect(created.customerPriceT.toString()).toBe('0');
  });
});
