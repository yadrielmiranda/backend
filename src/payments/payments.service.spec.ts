import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
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
      orderSequence: {
        create: jest.fn().mockResolvedValue({ id: 11 }),
      },
      order: {
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

    expect(tx.orderSequence.create).toHaveBeenCalledTimes(1);
    expect(tx.orderSequence.create).toHaveBeenCalledWith({ data: {} });
    expect(tx.order.create).toHaveBeenCalledTimes(1);
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ number: 'ORD-1011' }),
      }),
    );
    expect(tx.estimate.update).toHaveBeenCalledWith({
      where: { id: payment.estimate.id },
      data: { statusId: 2 },
    });
    expect(installationWorkflow.markPaymentPaid).toHaveBeenCalledTimes(1);
    expect(notifications.createAndSend).toHaveBeenCalledTimes(1);
    expect(notifications.createAndSend).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: 7,
        actorId: 7,
        notifyActor: true,
        message: 'Your order #ORD-1011 has been created from Estimate #EST-1009.',
        actionUrl: '/orders/11',
        dedupeKey: 'order:11:created:owner',
      }),
      tx,
    );
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

  it('uses the reserved sequence rather than the internal order id', async () => {
    const payment = materialPayment();
    const tx = {
      orderStatus: {
        findUnique: jest.fn().mockResolvedValue({ id: 1, name: 'Pending' }),
      },
      estimateStatus: {
        findUnique: jest.fn().mockResolvedValue({ id: 2, name: 'Ordered' }),
      },
      orderSequence: { create: jest.fn().mockResolvedValue({ id: 1 }) },
      order: {
        create: jest.fn().mockImplementation(async ({ data }) => ({
          id: 93,
          ...data,
        })),
      },
      estimate: { update: jest.fn().mockResolvedValue({}) },
      eventLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new PaymentsService(
      {} as never,
      config,
      {} as never,
      notifications as never,
    );

    await (service as any).ensureOrderForMaterialPayment(tx, payment);

    expect(tx.orderSequence.create).toHaveBeenCalledWith({ data: {} });
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ number: 'ORD-1001' }),
      }),
    );
    expect(tx.eventLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 93,
        message: 'Order #ORD-1001 created from paid material checkout.',
      }),
    });
    expect(notifications.createAndSend).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Your order #ORD-1001 has been created from Estimate #EST-1009.',
        actionUrl: '/orders/93',
        dedupeKey: 'order:93:created:owner',
      }),
      tx,
    );
  });

  it('uses each transaction reservation when different paid checkouts overlap', async () => {
    // Simula respuestas de la BD fuera de orden; no prueba los locks de MySQL.
    let releaseFirst!: () => void;
    const secondReservation = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const allocateSequence = jest
      .fn()
      .mockImplementationOnce(async () => {
        await secondReservation;
        return { id: 24 };
      })
      .mockImplementationOnce(async () => {
        releaseFirst();
        return { id: 25 };
      });
    const payments = [0, 1].map((index) =>
      materialPayment({
        id: 41 + index,
        idEst: 9 + index,
        stripeSessionId: `cs_parallel_${index}`,
        estimate: { ...materialPayment().estimate, id: 9 + index },
      }),
    );
    const transactions = payments.map((payment, index) => ({
      payment: { findUnique: jest.fn().mockResolvedValue(payment) },
      orderStatus: {
        findUnique: jest.fn().mockResolvedValue({ id: 1, name: 'Pending' }),
      },
      estimateStatus: {
        findUnique: jest.fn().mockResolvedValue({ id: 2, name: 'Ordered' }),
      },
      orderSequence: { create: allocateSequence },
      order: {
        create: jest.fn().mockImplementation(async ({ data }) => ({
          id: 301 + index,
          ...data,
        })),
        findUnique: jest.fn().mockResolvedValue({ id: 301 + index }),
      },
      estimate: { update: jest.fn().mockResolvedValue({}) },
      eventLog: { create: jest.fn().mockResolvedValue({}) },
    }));
    const installationWorkflow = {
      markPaymentPaid: jest.fn().mockResolvedValue(false),
    };
    const service = new PaymentsService(
      {} as never,
      config,
      installationWorkflow as never,
      notifications as never,
    );

    await Promise.all(
      transactions.map((tx, index) =>
        (service as any).processPaidCheckoutSession(tx, {
          id: payments[index].stripeSessionId,
          payment_status: 'paid',
        }),
      ),
    );

    expect(allocateSequence).toHaveBeenCalledTimes(2);
    const numbers = transactions.map((tx) => {
      expect(tx.order.create).toHaveBeenCalledTimes(1);
      return tx.order.create.mock.calls[0][0].data.number;
    });
    expect(numbers).toEqual(['ORD-1024', 'ORD-1025']);
    expect(new Set(numbers).size).toBe(2);
    expect(installationWorkflow.markPaymentPaid).toHaveBeenCalledTimes(2);
    expect(notifications.createAndSend).toHaveBeenCalledTimes(2);
    expect(notifications.createAndSendToRoles).toHaveBeenCalledTimes(2);
  });

  it('does not reserve a number when the estimate cannot create an order', async () => {
    const tx = {
      orderSequence: { create: jest.fn() },
      order: { create: jest.fn() },
    };
    const payment = materialPayment({
      estimate: {
        ...materialPayment().estimate,
        status: { id: 3, name: 'Expired' },
      },
    });
    const service = new PaymentsService(
      {} as never,
      config,
      {} as never,
      notifications as never,
    );

    await expect(
      (service as any).ensureOrderForMaterialPayment(tx, payment),
    ).rejects.toThrow('cannot create its paid material order');
    expect(tx.orderSequence.create).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(notifications.createAndSend).not.toHaveBeenCalled();
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
      orderSequence: { create: jest.fn() },
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
    expect(tx.orderSequence.create).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.estimate.update).not.toHaveBeenCalled();
    expect(installationWorkflow.markPaymentPaid).toHaveBeenCalledTimes(1);
    expect(notifications.createAndSend).not.toHaveBeenCalled();
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
      orderSequence: { create: jest.fn() },
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

    expect(tx.orderSequence.create).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.estimate.update).toHaveBeenCalledWith({
      where: { id: payment.estimate.id },
      data: { statusId: 2 },
    });
    expect(notifications.createAndSend).not.toHaveBeenCalled();
  });

  it.each(Object.values(PaymentType))('notifies only admins about a confirmed %s payment', async (type) => {
    const payment = materialPayment({
      type,
      estimate: {
        ...materialPayment().estimate,
        status: { id: 2, name: 'Ordered' },
        order: { id: 11, number: 'ORD-1011', paymentId: 41 },
      },
    });
    const tx = {
      payment: { findUnique: jest.fn().mockResolvedValue(payment) },
      order: { findUnique: jest.fn().mockResolvedValue({ id: 11 }) },
    };
    const workflow = { markPaymentPaid: jest.fn().mockResolvedValue(false) };
    const service = new PaymentsService({} as never, config, workflow as never, notifications as never);
    await (service as any).processPaidCheckoutSession(tx, {
      id: payment.stripeSessionId, payment_status: 'paid',
    });
    expect(notifications.createAndSend).not.toHaveBeenCalled();
    expect(notifications.createAndSendToRoles).toHaveBeenCalledWith(
      ['admin'], expect.objectContaining({ dedupeKey: 'payment:41:paid:admin' }), { db: tx },
    );
  });

  it('keeps manual payment confirmations with admins as well', async () => {
    const payment = materialPayment({ recordedById: 1 });
    const tx = { order: { findUnique: jest.fn().mockResolvedValue({ id: 11 }) } };
    const service = new PaymentsService({} as never, config, {} as never, notifications as never);
    await (service as any).notifyPaymentConfirmed(tx, payment);
    expect(notifications.createAndSend).not.toHaveBeenCalled();
    expect(notifications.createAndSendToRoles).toHaveBeenCalledWith(
      ['admin'], expect.objectContaining({ dedupeKey: 'payment:41:paid:admin' }), { db: tx },
    );
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
      orderSequence: {
        create: jest.fn().mockResolvedValue({ id: 11 }),
      },
      order: {
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
    expect(tx.orderSequence.create).toHaveBeenCalledTimes(1);
    expect(tx.orderSequence.create).toHaveBeenCalledWith({ data: {} });
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          number: 'ORD-1011',
          saleSubtotal: new Prisma.Decimal(1380),
          netProfit: new Prisma.Decimal(380),
        }),
      }),
    );
    expect(tx.eventLog.create).toHaveBeenCalledTimes(2);
  });
});
