import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DealerAffiliation,
  DealerMode,
  PaymentMethod,
  PaymentPayerType,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import Stripe from 'stripe';
import { PaymentsService } from './payments.service';

describe('PaymentsService reconciliation', () => {
  const config = {
    get: jest.fn((key: string) =>
      key === 'STRIPE_SECRET_KEY' ? 'sk_test_reconciliation' : undefined,
    ),
  } as unknown as ConfigService;
  const notifications = {
    createAndSend: jest.fn().mockResolvedValue({}),
    createAndSendToRoles: jest.fn().mockResolvedValue([]),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

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
      paymentMethod: PaymentMethod.CARD,
      payerType: PaymentPayerType.ACCOUNT_OWNER,
      payerName: 'Dealer User',
      payerEmail: 'dealer@example.com',
      payerPhone: '+13055550199',
      paidAt: new Date('2026-08-06T12:00:00Z'),
      manualReference: null,
      manualNote: null,
      recordedById: null,
      createdAt: new Date('2026-08-06T12:00:00Z'),
      updatedAt: new Date('2026-08-06T12:00:00Z'),
      estimate: {
        id: 9,
        number: 'EST-1009',
        units: 3,
        priceT: new Prisma.Decimal(1100),
        customerPriceT: new Prisma.Decimal(0),
        rateT: new Prisma.Decimal(800),
        netProfit: new Prisma.Decimal(300),
        dealerModeSnapshot: DealerMode.EXTERNAL,
        dealerAffiliationSnapshot: DealerAffiliation.IMPACT,
        ownerMarkupSnapshot: new Prisma.Decimal(0.15),
        idUser: 7,
        user: {
          id: 7,
          firstName: 'Dealer',
          lastName: 'User',
          email: 'dealer@example.com',
          phone: '+13055550199',
          role: { id: 3, name: 'dealer' },
        },
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
        findUnique: jest.fn().mockResolvedValue({ id: 11 }),
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
      notifications as never,
    );

    await service.reconcilePendingCheckoutSessions();

    expect(tx.order.create).toHaveBeenCalledTimes(1);
    expect(tx.estimate.update).toHaveBeenCalledWith({
      where: { id: payment.estimate.id },
      data: { statusId: 2 },
    });
    expect(installationWorkflow.markPaymentPaid).toHaveBeenCalledTimes(1);
    expect(notifications.createAndSendToRoles).toHaveBeenCalledWith(
      ['admin'],
      expect.objectContaining({
        actionUrl: '/orders/11',
        actionLabel: 'Open order',
        dedupeKey: `payment:${payment.id}:paid:admin`,
      }),
      expect.objectContaining({ db: tx }),
    );
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
      order: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ id: 11 }),
      },
      estimate: { update: jest.fn() },
    };
    const installationWorkflow = {
      markPaymentPaid: jest.fn().mockResolvedValue(false),
    };
    const service = new PaymentsService(
      {} as never,
      config,
      installationWorkflow as never,
      notifications as never,
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
      order: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ id: 11 }),
      },
    };
    const installationWorkflow = {
      markPaymentPaid: jest.fn().mockResolvedValue(false),
    };
    const service = new PaymentsService(
      {} as never,
      config,
      installationWorkflow as never,
      notifications as never,
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

  it('requires an internal dealer charge to use the final-customer public link', async () => {
    const tx = {};
    const prisma = {
      $transaction: jest.fn(
        async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const installationWorkflow = {
      getPaymentContext: jest.fn().mockResolvedValue({
        estimate: { dealerModeSnapshot: DealerMode.INTERNAL },
      }),
    };
    const service = new PaymentsService(
      prisma as never,
      config,
      installationWorkflow as never,
      notifications as never,
    );

    await expect(
      service.createCheckoutSessionForEstimate({
        estimateId: 9,
        type: PaymentType.MATERIAL,
        user: { id: 7, role: { name: 'dealer' } },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a manual payment without explicit verified-funds confirmation', async () => {
    const service = new PaymentsService(
      {} as never,
      config,
      {} as never,
      notifications as never,
    );

    await expect(
      service.recordManualPayment({
        estimateId: 9,
        type: PaymentType.MATERIAL,
        method: PaymentMethod.CHECK,
        fundsVerified: false as true,
        reference: 'CHK-1009',
        actor: { id: 1, role: { name: 'admin' } },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks a manual payment recorded by an external dealer', async () => {
    const prisma = {
      estimate: {
        findUnique: jest.fn().mockResolvedValue({
          id: 9,
          idUser: 7,
          dealerModeSnapshot: DealerMode.EXTERNAL,
          user: { role: { name: 'dealer' } },
        }),
      },
    };
    const service = new PaymentsService(
      prisma as never,
      config,
      {} as never,
      notifications as never,
    );

    await expect(
      service.recordManualPayment({
        estimateId: 9,
        type: PaymentType.MATERIAL,
        method: PaymentMethod.CHECK,
        fundsVerified: true,
        reference: 'CHK-1009',
        actor: { id: 7, role: { name: 'dealer' } },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('records a verified internal-customer check and creates the material order atomically', async () => {
    const internalEstimate = {
      ...materialPayment().estimate,
      priceT: new Prisma.Decimal(1200),
      customerPriceT: new Prisma.Decimal(1380),
      rateT: new Prisma.Decimal(1000),
      dealerModeSnapshot: DealerMode.INTERNAL,
      dealerAffiliationSnapshot: DealerAffiliation.IMPACT,
      ownerMarkupSnapshot: new Prisma.Decimal(-0.1668954),
      customerFirstName: 'Final',
      customerLastName: 'Customer',
      customerEmail: 'customer@example.com',
      customerPhone: '+13055550123',
    };
    const paidPayment = materialPayment({
      status: PaymentStatus.PAID,
      stripeSessionId: null,
      stripePaymentIntentId: null,
      baseAmount: new Prisma.Decimal(1380),
      amount: new Prisma.Decimal(1380),
      paymentMethod: PaymentMethod.CHECK,
      payerType: PaymentPayerType.CUSTOMER,
      estimate: internalEstimate,
    });
    const context = {
      estimate: internalEstimate,
      job: null,
      extraCharge: null,
      paymentSequence: 1,
      baseAmount: new Prisma.Decimal(1380),
    };
    const tx = {
      payment: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: paidPayment.id }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValueOnce(paidPayment)
          .mockResolvedValueOnce({ id: paidPayment.id, order: { id: 11 } }),
      },
      orderStatus: {
        findUnique: jest.fn().mockResolvedValue({ id: 1, name: 'Pending' }),
      },
      estimateStatus: {
        findUnique: jest.fn().mockResolvedValue({ id: 2, name: 'Ordered' }),
      },
      order: {
        findFirst: jest.fn().mockResolvedValue({ id: 10 }),
        findUnique: jest.fn().mockResolvedValue({ id: 11 }),
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
      estimate: {
        findUnique: jest.fn().mockResolvedValue({
          id: internalEstimate.id,
          idUser: internalEstimate.idUser,
          dealerModeSnapshot: DealerMode.INTERNAL,
          user: { role: { name: 'dealer' } },
        }),
      },
      payment: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(
        async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const installationWorkflow = {
      getPaymentContext: jest.fn().mockResolvedValue(context),
      markPaymentPaid: jest.fn().mockResolvedValue(false),
    };
    const service = new PaymentsService(
      prisma as never,
      config,
      installationWorkflow as never,
      notifications as never,
    );

    await service.recordManualPayment({
      estimateId: internalEstimate.id,
      type: PaymentType.MATERIAL,
      method: PaymentMethod.CHECK,
      fundsVerified: true,
      reference: 'CHK-1009',
      actor: { id: internalEstimate.idUser, role: { name: 'dealer' } },
    });

    expect(tx.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: PaymentStatus.PAID,
          paymentMethod: PaymentMethod.CHECK,
          payerType: PaymentPayerType.CUSTOMER,
          surchargeAmount: new Prisma.Decimal(0),
        }),
      }),
    );
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          saleSubtotal: new Prisma.Decimal(1380),
          impactProfit: new Prisma.Decimal(150),
          authenticProfit: new Prisma.Decimal(230),
        }),
      }),
    );
    expect(tx.eventLog.create).toHaveBeenCalledTimes(2);
  });
});
