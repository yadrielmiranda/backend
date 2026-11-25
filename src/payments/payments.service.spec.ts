// Estos tests aíslan autorización/efectos; el ledger real se prueba en payment-refunds.spec y payment-workflow.spec.
jest.mock('./payment-ledger', () => ({
  recordStripeReceipt: jest.fn(), recordManualReceipt: jest.fn(), refreshPaymentAccounting: jest.fn(),
  reconcileChargeRefunds: jest.fn(async () => ({ paymentIds: [], newRefundIds: [] })),
}));
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
import * as paymentSchedule from '@/payment-plans/payment-schedule';
import { recordManualReceipt } from './payment-ledger';
import { buildInstallationProcessingShare, freezeProcessingCostSnapshot, singleProcessingComponent, withInstallationProcessingShare } from './processing-cost-snapshot';

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
    jest.spyOn(PaymentsService.prototype as any, 'successfulCharge').mockImplementation(async (id: any) => ({
      id: `ch_${id}`, payment_intent: id, created: 1700000000, amount_captured: Number(id.slice('pi_test_'.length)),
      currency: 'usd', paid: true, captured: true, payment_method_details: { type: 'card', card: { brand: 'visa' } },
    }));
    jest.spyOn(PaymentsService.prototype as any, 'applyStripeRefunds').mockResolvedValue({ paymentIds: [], newRefundIds: [] });
  });

  describe('material acceptance at checkout', () => {
    const acceptanceText =
      'I have reviewed and accept the products, dimensions, configurations and prices in this estimate.';
    const client = { id: 7, role: { name: 'client' } } as const;

    function checkoutHarness(options: {
      role?: string;
      existing?: Record<string, unknown>;
      internal?: boolean;
      selfRegistered?: boolean;
      confirmedPickup?: boolean;
      savedAddress?: boolean;
    } = {}) {
      const estimate = materialPayment().estimate;
      const address = { street: '100 Main St', addressLine2: null, city: 'Miami', state: 'FL', postalCode: '33101' };
      const context = {
        estimate: {
          ...estimate,
          dealerModeSnapshot: options.internal ? DealerMode.INTERNAL : null,
          user: { ...estimate.user, role: { name: options.role ?? 'client' } },
        },
        job: null,
        paymentSequence: 1,
        baseAmount: new Prisma.Decimal('330.78'),
        surchargePercent: new Prisma.Decimal(0),
        surchargeAmount: new Prisma.Decimal(0),
        totalAmount: new Prisma.Decimal('330.78'),
        description: 'Material payment',
      };
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: 9 }]),
        estimate: {
          findFirst: jest.fn().mockResolvedValue({ id: 9 }),
          findUnique: jest.fn().mockResolvedValue({
            publicTokenEnabled: true, dealerModeSnapshot: DealerMode.INTERNAL,
            publicToken: 'customer-link', publicTotalToken: 'customer-total-link',
            user: { ...context.estimate.user, registrationConsent: options.selfRegistered ? { consentText: '{"source":"REGISTRATION"}' } : null,
              ...(options.savedAddress && { id: client.id, ...address, deliveryCoverageCheck: null }) },
            payments: [], order: null, installationJob: null,
            deliveryAcknowledgement: options.confirmedPickup ? { choice: 'PICKUP', verificationKey: null } : null,
          }),
        },
        warehouseDeliverySettings: { findUnique: jest.fn().mockResolvedValue({ revision: 2 }) },
        estimateAgreement: { findFirst: jest.fn().mockResolvedValue(null) },
        payment: {
          findUnique: jest.fn().mockResolvedValue(options.existing ?? null),
          upsert: jest.fn().mockResolvedValue({ id: 41 }),
          update: jest.fn().mockResolvedValue({ id: 41 }),
        },
      };
      const prisma = {
        $transaction: jest.fn(async (callback: (db: typeof tx) => Promise<unknown>) => callback(tx)),
      };
      const workflow = { getPaymentContext: jest.fn().mockResolvedValue(context) };
      const service = new PaymentsService(prisma as never, config, workflow as never, notifications as never);
      const stripe = (service as unknown as { stripe: Stripe }).stripe;
      const createSession = jest.spyOn(stripe.checkout.sessions, 'create').mockResolvedValue({
        id: 'cs_new', url: 'https://checkout.stripe.com/new',
      } as Stripe.Response<Stripe.Checkout.Session>);
      const retrieveSession = jest.spyOn(stripe.checkout.sessions, 'retrieve').mockResolvedValue({
        id: 'cs_open', status: 'open', payment_status: 'unpaid',
        url: 'https://checkout.stripe.com/open',
      } as Stripe.Response<Stripe.Checkout.Session>);
      return { service, tx, workflow, createSession, retrieveSession };
    }

    it.each([undefined, false, 'true'])('rejects a client material checkout without explicit acceptance (%s)', async (accepted) => {
      const { service, tx, createSession, retrieveSession } = checkoutHarness();
      await expect(service.createCheckoutSessionForEstimate({
        estimateId: 9,
        user: client,
        materialAccepted: accepted as boolean | undefined,
      })).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.payment.upsert).not.toHaveBeenCalled();
      expect(tx.payment.update).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(retrieveSession).not.toHaveBeenCalled();
    });

    it.each([PaymentType.MATERIAL, PaymentType.INSTALLMENT])('requires an address or confirmation of pickup before a public client can start %s checkout', async type => {
      const { service, tx, createSession } = checkoutHarness({ selfRegistered: true });
      await expect(service.createCheckoutSessionForEstimate({
        estimateId: 9, user: client, type, materialAccepted: true,
      })).rejects.toMatchObject({ response: { code: 'CLIENT_DELIVERY_DECISION_REQUIRED' } });
      expect(tx.payment.upsert).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    });

    it('allows clients with a saved address to open checkout without a coverage check or a fulfillment decision', async () => {
      const { service, createSession, tx } = checkoutHarness({ selfRegistered: true, savedAddress: true });
      await expect(service.createCheckoutSessionForEstimate({
        estimateId: 9, user: client, materialAccepted: true,
      })).resolves.toMatchObject({ url: 'https://checkout.stripe.com/new' });
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(tx.warehouseDeliverySettings.findUnique).not.toHaveBeenCalled();
    });

    it('allows a client to pay after confirming Miami pickup without providing a delivery address', async () => {
      const { service, createSession } = checkoutHarness({ selfRegistered: true, confirmedPickup: true });
      await expect(service.createCheckoutSessionForEstimate({
        estimateId: 9, user: client, materialAccepted: true,
      })).resolves.toMatchObject({ url: 'https://checkout.stripe.com/new' });
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it('rechecks a pending Stripe session but reconciles money collected before delivery was reviewed', async () => {
      const { service, tx, createSession, retrieveSession } = checkoutHarness({
        selfRegistered: true, existing: { id: 41, status: PaymentStatus.PENDING, stripeSessionId: 'cs_open' },
      });
      const request = { estimateId: 9, user: client, materialAccepted: true };
      await expect(service.createCheckoutSessionForEstimate(request)).rejects.toMatchObject({
        response: { code: 'CLIENT_DELIVERY_DECISION_REQUIRED' },
      });
      expect(tx.payment.update).not.toHaveBeenCalled();
      retrieveSession.mockResolvedValueOnce({
        id: 'cs_open', status: 'complete', payment_status: 'paid', amount_total: 33078,
      } as Stripe.Response<Stripe.Checkout.Session>);
      const reconcile = jest.spyOn(service as any, 'processPaidCheckoutSession').mockResolvedValue(true);
      await expect(service.createCheckoutSessionForEstimate(request)).resolves.toHaveProperty('url');
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(createSession).not.toHaveBeenCalled();
    });

    it('stores the displayed text and acceptance time with the pending payment', async () => {
      const { service, tx } = checkoutHarness();
      const startedAt = Date.now();
      await service.createCheckoutSessionForEstimate({
        estimateId: 9, user: client, materialAccepted: true,
      });
      const { create } = tx.payment.upsert.mock.calls[0][0];
      expect(create).toMatchObject({
        idEst: 9, userId: 7, type: PaymentType.MATERIAL,
        status: PaymentStatus.PENDING,
        materialAcceptanceText: acceptanceText,
      });
      expect(create.materialAcceptedAt).toBeInstanceOf(Date);
      expect(create.materialAcceptedAt.getTime()).toBeGreaterThanOrEqual(startedAt);
      expect(create.paidAt).toBeUndefined();
    });

    it('preserves the original acceptance when resuming the same checkout', async () => {
      const { service, tx, createSession } = checkoutHarness({ existing: {
        id: 41, stripeSessionId: 'cs_open', status: PaymentStatus.PENDING,
        materialAcceptanceText: acceptanceText,
        materialAcceptedAt: new Date('2026-09-13T18:00:00Z'),
      } });
      const result = await service.createCheckoutSessionForEstimate({
        estimateId: 9, user: client, materialAccepted: true,
      });
      expect(result.url).toBe('https://checkout.stripe.com/open');
      expect(tx.payment.update).not.toHaveBeenCalled();
      expect(tx.payment.upsert).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    });

    it('records an explicit acceptance when resuming a legacy checkout', async () => {
      const { service, tx } = checkoutHarness({ existing: {
        id: 41, stripeSessionId: 'cs_open', status: PaymentStatus.PENDING,
        materialAcceptanceText: null, materialAcceptedAt: null,
      } });
      await service.createCheckoutSessionForEstimate({
        estimateId: 9, user: client, materialAccepted: true,
      });
      expect(tx.payment.update).toHaveBeenCalledWith({
        where: { id: 41 },
        data: { materialAcceptanceText: acceptanceText, materialAcceptedAt: expect.any(Date) },
      });
    });

    it('does not reuse a canceled acceptance to authorize another checkout', async () => {
      const { service, tx, createSession } = checkoutHarness({ existing: {
        id: 41, status: PaymentStatus.CANCELED,
        materialAcceptanceText: acceptanceText,
        materialAcceptedAt: new Date('2026-09-13T18:00:00Z'),
      } });
      await expect(service.createCheckoutSessionForEstimate({
        estimateId: 9, user: client,
      })).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.payment.upsert).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    });

    it('refreshes acceptance for a new checkout after canceling', async () => {
      const previousDate = new Date('2020-01-01T00:00:00Z');
      const { service, tx } = checkoutHarness({ existing: {
        id: 41, status: PaymentStatus.CANCELED,
        materialAcceptanceText: acceptanceText, materialAcceptedAt: previousDate,
      } });
      await service.createCheckoutSessionForEstimate({
        estimateId: 9, user: client, materialAccepted: true,
      });
      const { update } = tx.payment.upsert.mock.calls[0][0];
      expect(update.materialAcceptanceText).toBe(acceptanceText);
      expect(update.materialAcceptedAt.getTime()).toBeGreaterThan(previousDate.getTime());
      expect(update.paidAt).toBeNull();
    });

    it.each([false, true])('does not add material acceptance to a dealer checkout (internal: %s)', async (internal) => {
      const { service, tx } = checkoutHarness({ role: 'dealer', internal });
      await service.createCheckoutSessionForEstimate({
        estimateId: 9, user: { id: 7, role: { name: 'dealer' } },
        ...(internal ? { publicToken: 'customer-link' } : {}),
      });
      const { create, update } = tx.payment.upsert.mock.calls[0][0];
      expect(create.materialAcceptanceText).toBeUndefined();
      expect(update.materialAcceptedAt).toBeUndefined();
    });

    it('uses the estimate owner role from the DB to require acceptance', async () => {
      const { service } = checkoutHarness();
      await expect(service.createCheckoutSessionForEstimate({
        estimateId: 9, user: { id: 7, role: { name: 'dealer' } },
      })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('keeps the deposit acceptance separate', async () => {
      const { service, tx, workflow } = checkoutHarness();
      await service.createCheckoutSessionForEstimate({
        estimateId: 9, user: client, type: PaymentType.INSTALLATION_DEPOSIT,
        installationDepositTermsAccepted: true,
      });
      expect(workflow.getPaymentContext).toHaveBeenCalledWith(
        9, PaymentType.INSTALLATION_DEPOSIT, undefined, true, client, tx, { preview: false },
      );
      expect(tx.payment.upsert.mock.calls[0][0].create.materialAcceptanceText).toBeUndefined();
    });

    it('freezes installation principal from the remaining basis after reserving another open checkout', async () => {
      const { service, tx, workflow } = checkoutHarness({ role: 'dealer', existing: { id: 41, status: PaymentStatus.CANCELED } });
      const previousContext = await workflow.getPaymentContext();
      const share = buildInstallationProcessingShare({ quote: { id: 17, version: 1, total: '0.03', providerCostSnapshot: { schema: 1, total: '0.01' } } });
      const components = withInstallationProcessingShare(singleProcessingComponent('installation', '0.01'), share);
      const reservedSnapshot = freezeProcessingCostSnapshot({ baseAmount: '0.01', surchargeAmount: '0', totalAmount: '0.01', processingComponents: components });
      workflow.getPaymentContext.mockResolvedValue({ ...previousContext, baseAmount: new Prisma.Decimal('0.01'),
        totalAmount: new Prisma.Decimal('0.01'), processingComponents: components });
      const findReceipts = jest.fn(async () => []);
      const findReserved = jest.fn(async () => [{ id: 51, type: PaymentType.INSTALLMENT, amount: new Prisma.Decimal('0.01'),
        originalBaseAmount: new Prisma.Decimal('999'), surchargeAmount: new Prisma.Decimal(0), processingCostSnapshot: reservedSnapshot }]);
      Object.assign(tx, { paymentReceipt: { findMany: findReceipts } });
      Object.assign(tx.payment, { findMany: findReserved });
      await service.createCheckoutSessionForEstimate({ estimateId: 9, type: PaymentType.INSTALLATION,
        user: { id: 7, role: { name: 'dealer' } } });
      expect(findReceipts).toHaveBeenCalledWith(expect.objectContaining({ where: { payment: { idEst: 9 } } }));
      expect(findReserved).toHaveBeenCalledWith(expect.objectContaining({ where: {
        idEst: 9, status: PaymentStatus.PENDING, stripeSessionId: { not: null }, id: { notIn: [41] },
      } }));
      const snapshot = tx.payment.upsert.mock.calls[0][0].update.processingCostSnapshot;
      expect(snapshot.installationShare).toMatchObject({ components: { provider: '0.01', company: '0.00', dealer: '0.00' },
        basis: { quoteId: 17, quoteVersion: 1, provider: '0.01', company: '0.02', dealer: '0.00' } });
      expect(snapshot.total).toBe('0.01');
    });
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
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        findUniqueOrThrow: jest.fn().mockResolvedValue(payment),
        findMany: jest.fn().mockResolvedValue([payment]),
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
        findUnique: jest.fn().mockResolvedValue({ id: 11, status: { name: 'Pending' } }),
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
      paymentRefund: { findMany: jest.fn().mockResolvedValue([]) },
      stripeProcessingCost: { findMany: jest.fn().mockResolvedValue([]) },
      payment: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
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
      {
        message: 'Order #ORD-1011 has been created from Estimate #EST-1009.',
        actionUrl: '/orders/11',
        actionLabel: 'Open order',
        dedupeKey: 'order:11:created:admin',
      },
      { db: tx },
    );
    expect(notifications.createAndSendToRoles).toHaveBeenCalledTimes(1);
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
      $queryRaw: jest.fn().mockResolvedValue([]),
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

    await (service as any).ensureOrderForInitialPayment(tx, payment);

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
    expect(notifications.createAndSendToRoles).toHaveBeenCalledWith(
      ['admin'],
      {
        message: 'Order #ORD-1001 has been created from Estimate #EST-1009.',
        actionUrl: '/orders/93',
        actionLabel: 'Open order',
        dedupeKey: 'order:93:created:admin',
      },
      { db: tx },
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
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        findUniqueOrThrow: jest.fn().mockResolvedValue(payment),
        findMany: jest.fn().mockResolvedValue([payment]),
      },
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
        findUnique: jest.fn().mockResolvedValue({ id: 301 + index, status: { name: 'Pending' } }),
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
          payment_status: 'paid', payment_intent: `pi_test_${Math.round(Number(payments[index].amount) * 100)}`, amount_total: Math.round(Number(payments[index].amount) * 100), currency: 'usd',
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
    expect(notifications.createAndSendToRoles.mock.calls.map(([, notice]) => notice.dedupeKey).sort()).toEqual([
      'order:301:created:admin', 'order:302:created:admin',
    ]);
  });

  it('does not reserve a number when the estimate cannot create an order', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
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
      (service as any).ensureOrderForInitialPayment(tx, payment),
    ).rejects.toThrow('cannot create its paid material order');
    expect(tx.orderSequence.create).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(notifications.createAndSend).not.toHaveBeenCalled();
    expect(notifications.createAndSendToRoles).not.toHaveBeenCalled();
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
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        findUniqueOrThrow: jest.fn().mockResolvedValue(payment),
        findMany: jest.fn().mockResolvedValue([payment]),
      },
      orderSequence: { create: jest.fn() },
      order: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ id: 11, status: { name: 'Pending' } }),
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
      payment_status: 'paid', payment_intent: `pi_test_${Math.round(Number(payment.amount) * 100)}`, amount_total: Math.round(Number(payment.amount) * 100), currency: 'usd',
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
    expect(notifications.createAndSendToRoles).not.toHaveBeenCalled();
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
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        findUniqueOrThrow: jest.fn().mockResolvedValue(payment),
        findMany: jest.fn().mockResolvedValue([payment]),
      },
      estimateStatus: {
        findUnique: jest.fn().mockResolvedValue({ id: 2, name: 'Ordered' }),
      },
      estimate: { update: jest.fn().mockResolvedValue({}) },
      orderSequence: { create: jest.fn() },
      order: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ id: 11, status: { name: 'Pending' } }),
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
      payment_status: 'paid', payment_intent: `pi_test_${Math.round(Number(payment.amount) * 100)}`, amount_total: Math.round(Number(payment.amount) * 100), currency: 'usd',
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
    expect(notifications.createAndSendToRoles).not.toHaveBeenCalled();
  });

  it.each(Object.values(PaymentType))('keeps confirmed %s collections admin-only for external dealers', async type => {
    const tx = { estimate: { findUnique: jest.fn().mockResolvedValue(null) }, order: { findUnique: jest.fn().mockResolvedValue({ id: 11 }) } };
    const service = new PaymentsService({} as never, config, {} as never, notifications as never);
    await (service as any).notifyPaymentCollection(tx, [materialPayment({ type })], 'stripe:ch_external');
    expect(notifications.createAndSend).not.toHaveBeenCalled();
    expect(notifications.createAndSendToRoles).toHaveBeenCalledWith(['admin'], expect.objectContaining({
      message: expect.stringContaining('of $1,250.00 confirmed from Dealer User for Estimate #EST-1009.'),
      dedupeKey: 'payment:41:received:stripe:ch_external:admin',
    }), { db: tx });
  });

  describe('internal dealer payment collections', () => {
    let schedule: jest.SpyInstance;
    beforeEach(() => {
      schedule = jest.spyOn(paymentSchedule, 'getPaymentSchedule').mockResolvedValue({
        balance: '500.00', provisional: false, refundReviewPending: false,
        rows: [{ sequence: 1, balance: '500.00', status: 'DUE' }],
      } as never);
    });
    afterEach(() => schedule.mockRestore());
    function internalPayment(overrides: Record<string, unknown> = {}) {
      const payment = materialPayment();
      return materialPayment({ recordedById: 7, ...overrides, estimate: {
        ...payment.estimate, dealerModeSnapshot: DealerMode.INTERNAL,
        user: { ...payment.estimate.user, dealerMode: DealerMode.INTERNAL },
      } });
    }
    function receiptHarness(order: { id: number } | null = { id: 11 }) {
      const tx = { order: { findUnique: jest.fn().mockResolvedValue(order) } };
      const service = new PaymentsService({} as never, config, {} as never, notifications as never);
      return { tx, service, confirm: (payments: unknown[], source = 'stripe:ch_paid') =>
        (service as any).notifyPaymentCollection(tx, payments, source) };
    }
    it.each(Object.values(PaymentType))('notifies the internal owner and admins once for a %s collection', async type => {
      const f = receiptHarness();
      await f.confirm([internalPayment({ type })]);
      expect(notifications.createAndSend).toHaveBeenCalledTimes(1);
      expect(notifications.createAndSend).toHaveBeenCalledWith(expect.objectContaining({
        recipientId: 7, actorId: 7, notifyActor: true,
        message: expect.stringContaining('of $1,250.00 confirmed for Estimate #EST-1009.'),
        actionUrl: '/orders/11', actionLabel: 'View order', dedupeKey: 'payment:41:received:stripe:ch_paid:owner',
      }), f.tx);
      expect(notifications.createAndSendToRoles).toHaveBeenCalledTimes(1);
      expect(notifications.createAndSendToRoles).toHaveBeenCalledWith(['admin'], expect.objectContaining({
        dedupeKey: 'payment:41:received:stripe:ch_paid:admin',
      }), { db: f.tx });
    });
    it('uses the project owner rather than payer or recorder and includes the recording administrator', async () => {
      const f = receiptHarness(null);
      await f.confirm([internalPayment({ userId: 81, recordedById: 1, payerType: PaymentPayerType.CUSTOMER, payerName: 'Final Customer' })], 'manual:receipt-one');
      expect(notifications.createAndSend).toHaveBeenCalledWith(expect.objectContaining({
        recipientId: 7, actorId: 1, notifyActor: true, actionUrl: '/estimates/9', actionLabel: 'View estimate',
        dedupeKey: 'payment:41:received:manual:receipt-one:owner',
      }), f.tx);
      expect(notifications.createAndSendToRoles.mock.calls[0][1]).not.toHaveProperty('actorId');
    });
    it('totals only this collection across installments and shows fees separately from principal credit', async () => {
      const f = receiptHarness();
      await f.confirm([
        internalPayment({ type: PaymentType.INSTALLMENT, baseAmount: new Prisma.Decimal(1000), surchargeAmount: new Prisma.Decimal(30), netPaidBaseAmount: new Prisma.Decimal(3000) }),
        internalPayment({ id: 42, sequence: 2, type: PaymentType.INSTALLMENT, baseAmount: new Prisma.Decimal(250), surchargeAmount: new Prisma.Decimal('7.50'), netPaidBaseAmount: new Prisma.Decimal(750) }),
      ]);
      expect(notifications.createAndSendToRoles).toHaveBeenCalledTimes(1);
      expect(notifications.createAndSend).toHaveBeenCalledTimes(1);
      expect(notifications.createAndSend).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Payment of $1,287.50 confirmed for Estimate #EST-1009. Remaining payment-plan balance: $500.00. Includes $37.50 in processing fees; $1,250.00 applied to the balance.',
      }), f.tx);
    });
    it('keeps distinct collection identities when an installment, payment date and reference are reused', async () => {
      const f = receiptHarness();
      const payment = internalPayment({ paidAt: new Date('2026-08-06T00:00:00Z'), manualReference: 'SAME-REFERENCE' });
      for (const source of ['stripe:ch_first', 'stripe:ch_second', 'manual:receipt-one', 'manual:receipt-two', 'manual:receipt-two']) await f.confirm([payment], source);
      expect(notifications.createAndSendToRoles.mock.calls.map(([, notice]) => notice.dedupeKey)).toEqual([
        'payment:41:received:stripe:ch_first:admin', 'payment:41:received:stripe:ch_second:admin',
        'payment:41:received:manual:receipt-one:admin', 'payment:41:received:manual:receipt-two:admin', 'payment:41:received:manual:receipt-two:admin',
      ]);
    });
    it.each([[PaymentStatus.PENDING, true], [PaymentStatus.PAID, false], [PaymentStatus.REFUNDED, false]])
    ('announces only a new Stripe collection, not a %s replay', async (status, newlyConfirmed) => {
      const payment = internalPayment({ type: PaymentType.PERMIT, status });
      const confirmed = { ...payment, status: PaymentStatus.PAID };
      const f = receiptHarness();
      const effects = jest.spyOn(f.service as any, 'ensurePaidPaymentEffects').mockResolvedValue(false);
      const notice = jest.spyOn(f.service as any, 'notifyPaymentCollection').mockResolvedValue(undefined);
      const tx = { $queryRaw: jest.fn().mockResolvedValue([]), payment: {
        findMany: jest.fn().mockResolvedValue([payment]), findUniqueOrThrow: jest.fn().mockResolvedValue(confirmed), update: jest.fn().mockResolvedValue(confirmed),
      } };
      await (f.service as any).processPaidCheckoutSession(tx, { id: payment.stripeSessionId, payment_status: 'paid', payment_intent: 'pi_test_125000', amount_total: 125000, currency: 'usd' });
      expect(effects).toHaveBeenCalledWith(tx, confirmed);
      if (newlyConfirmed) expect(notice).toHaveBeenCalledWith(tx, [confirmed], 'stripe:ch_pi_test_125000');
      else expect(notice).not.toHaveBeenCalled();
    });
    it('does not backfill receipts while repairing partial installment effects', async () => {
      const f = receiptHarness();
      await (f.service as any).ensurePaidPaymentEffects(f.tx, internalPayment({ type: PaymentType.INSTALLMENT,
        baseAmount: new Prisma.Decimal(250), netPaidBaseAmount: new Prisma.Decimal(1000), originalBaseAmount: new Prisma.Decimal(1500) }));
      expect(notifications.createAndSendToRoles).not.toHaveBeenCalled();
      expect(notifications.createAndSend).not.toHaveBeenCalled();
    });
    it.each([
      ['0.00', false, false, true], ['500.00', false, false, false], ['0.00', true, false, false], ['0.00', false, true, false],
    ])('reserves full wording for final zero balances (%s, provisional=%s, review=%s)', async (balance, provisional, refundReviewPending, full) => {
      schedule.mockResolvedValue({ balance, provisional, refundReviewPending });
      const f = receiptHarness();
      await f.confirm([internalPayment({ type: PaymentType.INSTALLMENT })]);
      expect(notifications.createAndSend.mock.calls[0][0].message.startsWith('Full payment')).toBe(full);
    });
    it.each([
      { baseAmount: new Prisma.Decimal(0), surchargeAmount: new Prisma.Decimal(0) },
      { status: PaymentStatus.PENDING }, { status: PaymentStatus.REFUNDED }, { refundReviewPending: true },
    ])('skips zero, unconfirmed, refunded and under-review collections: %p', async override => {
      const f = receiptHarness(); await f.confirm([internalPayment(override)]);
      expect(notifications.createAndSendToRoles).not.toHaveBeenCalled();
      expect(notifications.createAndSend).not.toHaveBeenCalled();
    });
    it.each([
      ['dealer', DealerMode.EXTERNAL], ['dealer', null], ['client', DealerMode.INTERNAL], ['admin', DealerMode.INTERNAL], ['operator', DealerMode.INTERNAL],
    ])('does not add owner receipts for role %s and mode %s', async (role, dealerMode) => {
      const payment = internalPayment();
      payment.estimate.user = { ...payment.estimate.user, dealerMode, role: { ...payment.estimate.user.role, name: role } } as typeof payment.estimate.user;
      const f = receiptHarness(); await f.confirm([payment]);
      expect(notifications.createAndSend).not.toHaveBeenCalled();
      expect(notifications.createAndSendToRoles).toHaveBeenCalledTimes(1);
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

  it.each(['admin', 'dealer'] as const)('lets %s record a verified internal-customer check without requiring a contract signature', async role => {
    const internalEstimate = {
      ...materialPayment().estimate,
      user: { ...materialPayment().estimate.user, dealerMode: DealerMode.INTERNAL },
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
      recordedById: role === 'admin' ? 1 : internalEstimate.idUser,
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
      $queryRaw: jest.fn().mockResolvedValue([]),
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
        findUnique: jest.fn().mockResolvedValue({ id: 11, status: { name: 'Pending' } }),
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
      actor: { id: role === 'admin' ? 1 : internalEstimate.idUser, role: { name: role } },
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
    expect(notifications.createAndSend).toHaveBeenCalledWith(expect.objectContaining({
      recipientId: internalEstimate.idUser,
      actorId: role === 'admin' ? 1 : internalEstimate.idUser,
      notifyActor: true,
      message: 'Material payment of $1,380.00 confirmed for Estimate #EST-1009.',
      dedupeKey: `payment:${paidPayment.id}:received:${jest.mocked(recordManualReceipt).mock.calls.at(-1)![2]}:owner`,
    }), tx);
  });
});
