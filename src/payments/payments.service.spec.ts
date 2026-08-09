import { ConfigService } from '@nestjs/config';
import { PaymentStatus, PaymentType, Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { PaymentsService } from './payments.service';

describe('PaymentsService reconciliation', () => {
  const config = {
    get: jest.fn((key: string) =>
      key === 'STRIPE_SECRET_KEY' ? 'sk_test_reconciliation' : undefined,
    ),
  } as unknown as ConfigService;

  function materialPayment(overrides: Record<string, unknown> = {}) {
    return {
      id: 41,
      status: PaymentStatus.PAID,
      type: PaymentType.MATERIAL,
      sequence: 1,
      idEst: 9,
      installationJobId: null,
      extraChargeId: null,
      userId: 7,
      baseAmount: new Prisma.Decimal(1250),
      surchargePercent: new Prisma.Decimal(0),
      surchargeAmount: new Prisma.Decimal(0),
      amount: new Prisma.Decimal(1250),
      currency: 'usd',
      stripeSessionId: 'cs_paid_material',
      stripePaymentIntentId: 'pi_paid_material',
      stripeCustomerId: null,
      createdAt: new Date('2026-08-06T12:00:00Z'),
      updatedAt: new Date('2026-08-06T12:00:00Z'),
      estimate: {
        id: 9,
        number: 'EST-1009',
        units: 3,
        priceT: new Prisma.Decimal(1100),
        rateT: new Prisma.Decimal(800),
        netProfit: new Prisma.Decimal(300),
        idUser: 7,
        status: { id: 1, name: 'Active' },
        order: null,
      },
      ...overrides,
    };
  }

  it('repairs a paid material payment that has no order', async () => {
    const payment = materialPayment();
    const tx = {
      payment: { findUnique: jest.fn().mockResolvedValue(payment) },
      orderStatus: {
        findUnique: jest.fn().mockResolvedValue({ id: 1, name: 'Pending' }),
      },
      estimateStatus: {
        findUnique: jest.fn().mockResolvedValue({ id: 2, name: 'Ordered' }),
      },
      order: {
        findFirst: jest.fn().mockResolvedValue({ id: 10 }),
        create: jest.fn().mockResolvedValue({
          id: 11,
          number: 'ORD-1011',
          status: { id: 1, name: 'Pending' },
        }),
      },
      estimate: { update: jest.fn().mockResolvedValue({}) },
      eventLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      payment: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: payment.id }]),
      },
      $transaction: jest.fn(
        async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const installationWorkflow = {
      markPaymentPaid: jest.fn().mockResolvedValue(false),
    };
    const service = new PaymentsService(
      prisma as never,
      config,
      installationWorkflow as never,
    );

    await service.reconcilePendingCheckoutSessions();

    expect(tx.order.create).toHaveBeenCalledTimes(1);
    expect(tx.estimate.update).toHaveBeenCalledWith({
      where: { id: payment.estimate.id },
      data: { statusId: 2 },
    });
    expect(installationWorkflow.markPaymentPaid).toHaveBeenCalledTimes(1);
    expect(tx.eventLog.create).toHaveBeenCalledTimes(2);
    expect(tx.eventLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: 'UPDATE',
        entityType: 'Payment',
        entityId: payment.id,
      }),
    });
  });

  it('reprocessing an already consistent paid session creates nothing twice', async () => {
    const payment = materialPayment({
      estimate: {
        ...materialPayment().estimate,
        status: { id: 2, name: 'Ordered' },
        order: {
          id: 11,
          number: 'ORD-1011',
          paymentId: 41,
        },
      },
    });
    const tx = {
      payment: { findUnique: jest.fn().mockResolvedValue(payment) },
      order: { create: jest.fn() },
      estimate: { update: jest.fn() },
    };
    const installationWorkflow = {
      markPaymentPaid: jest.fn().mockResolvedValue(false),
    };
    const service = new PaymentsService(
      {} as never,
      config,
      installationWorkflow as never,
    );
    const session = {
      id: payment.stripeSessionId,
      payment_status: 'paid',
    } as Stripe.Checkout.Session;

    const processed = await (
      service as unknown as {
        processPaidCheckoutSession(
          client: typeof tx,
          checkout: Stripe.Checkout.Session,
        ): Promise<boolean>;
      }
    ).processPaidCheckoutSession(tx, session);

    expect(processed).toBe(true);
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.estimate.update).not.toHaveBeenCalled();
    expect(installationWorkflow.markPaymentPaid).toHaveBeenCalledTimes(1);
  });

  it('repairs an active estimate when its paid order already exists', async () => {
    const payment = materialPayment({
      estimate: {
        ...materialPayment().estimate,
        order: {
          id: 11,
          number: 'ORD-1011',
          paymentId: 41,
        },
      },
    });
    const tx = {
      payment: { findUnique: jest.fn().mockResolvedValue(payment) },
      estimateStatus: {
        findUnique: jest.fn().mockResolvedValue({ id: 2, name: 'Ordered' }),
      },
      estimate: { update: jest.fn().mockResolvedValue({}) },
      order: { create: jest.fn() },
    };
    const installationWorkflow = {
      markPaymentPaid: jest.fn().mockResolvedValue(false),
    };
    const service = new PaymentsService(
      {} as never,
      config,
      installationWorkflow as never,
    );
    const session = {
      id: payment.stripeSessionId,
      payment_status: 'paid',
    } as Stripe.Checkout.Session;

    await (
      service as unknown as {
        processPaidCheckoutSession(
          client: typeof tx,
          checkout: Stripe.Checkout.Session,
        ): Promise<boolean>;
      }
    ).processPaidCheckoutSession(tx, session);

    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.estimate.update).toHaveBeenCalledWith({
      where: { id: payment.estimate.id },
      data: { statusId: 2 },
    });
  });
});
