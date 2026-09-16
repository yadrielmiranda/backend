import { ConfigService } from '@nestjs/config';
import { PaymentMethod, PaymentType, Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { PaymentsService } from '@/payments/payments.service';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import {
  buildPaymentSchedule,
  refreshScheduledInstallation,
} from './payment-schedule';
import { planRows, PlanDefinition } from './payment-plan';
import { ValidationPipe } from '@nestjs/common';
import { RegisterUserDto } from '@/auth/dto/register-user.dto';
import { UpdateProfileDto } from '@/auth/dto/update-profile.dto';
import { withAgreementTransaction } from '@/contracts/agreement-content';
import { DeliveriesService } from '@/deliveries/deliveries.service';

const plan: PlanDefinition = {
  withInstallation: [
    { milestone: 'ORDER', basis: 'PROJECT', percent: 50 },
    { milestone: 'RELEASE', basis: 'PROJECT', percent: 40 },
    { milestone: 'COMPLETE', basis: 'PROJECT', percent: 10 },
  ],
  withoutInstallation: [
    { milestone: 'ORDER', basis: 'MATERIAL', percent: 50 },
    { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 },
  ],
};
const decimal = (v: number) => new Prisma.Decimal(v);

// Servicios reales, Stripe y persistencia simulados; nunca realiza cobros externos.
function fixture({
  mode = 'EXTERNAL',
  role = 'dealer',
  deposit = 250,
  material = 8000,
  installation = 2000,
} = {}) {
  const estimate: any = {
    id: 1,
    idUser: 7,
    number: '190999',
    units: 2,
    status: { name: 'Active' },
    order: null,
    payments: [],
    priceT: decimal(material),
    rateT: decimal(5000),
    customerPriceT: decimal(material),
    totalPayable: decimal(material),
    customerTotalPayable: decimal(material),
    taxAmount: decimal(0),
    taxRate: decimal(0),
    dealerModeSnapshot: mode,
    paymentPlanSnapshot: {
      version: 1,
      planId: 2,
      name: 'Project 50/40/10',
      definition: plan,
    },
    customerFirstName: 'Jane',
    customerLastName: 'Rivera',
    customerEmail: 'jane@example.test',
    customerPhone: '+13055550111',
    customerStreet: '123 Example Street',
    customerCity: 'Miami',
    customerState: 'FL',
    customerPostalCode: '33101',
    user: {
      id: 7,
      firstName: 'Account',
      lastName: 'Owner',
      email: 'owner@example.test',
      phone: '+13055550122',
      role: { name: role },
    },
    installationJob: installation
      ? {
          id: 3,
          estimateId: 1,
          status: 'MATERIAL_PAYMENT_PENDING',
          quotes: [{ status: 'APPROVED', total: decimal(installation) }],
          permit: null,
          appointments: [],
        }
      : null,
  };
  if (deposit)
    estimate.payments.push({
      id: 9,
      idEst: 1,
      type: 'INSTALLATION_DEPOSIT',
      sequence: 1,
      status: 'PAID',
      baseAmount: decimal(deposit),
      amount: decimal(deposit),
    });
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
    estimate: {
      findUnique: jest.fn(async () => estimate),
      findUniqueOrThrow: jest.fn(async () => estimate),
      findFirst: jest.fn(async ({ where }) =>
        where.dealerModeSnapshot === 'INTERNAL' && mode !== 'INTERNAL'
          ? null
          : estimate,
      ),
      update: jest.fn(async ({ data }) => {
        Object.assign(estimate, data);
        if (data.statusId === 2) estimate.status = { name: 'Ordered' };
        return estimate;
      }),
    },
    globalParameter: {
      findUnique: jest.fn(async () => ({ value: decimal(0.03) })),
    },
    installationJob: {
      update: jest.fn(async ({ data }) =>
        Object.assign(estimate.installationJob, data),
      ),
    },
    payment: {
      findUnique: jest.fn(async ({ where }) => {
        const key = where.idEst_type_sequence;
        const p = estimate.payments.find((p) =>
          key
            ? p.type === key.type && p.sequence === key.sequence
            : where.stripeSessionId
              ? p.stripeSessionId === where.stripeSessionId
              : p.id === where.id,
        );
        return p
          ? {
              ...p,
              estimate,
              order: estimate.order?.paymentId === p.id ? estimate.order : null,
            }
          : null;
      }),
      upsert: jest.fn(async ({ where, create, update }) => {
        const old = estimate.payments.find(
          (p) =>
            p.type === where.idEst_type_sequence.type &&
            p.sequence === where.idEst_type_sequence.sequence,
        );
        if (old) return Object.assign(old, update);
        const p = { id: 40 + estimate.payments.length, ...create };
        estimate.payments.push(p);
        return p;
      }),
      update: jest.fn(async ({ where, data }) =>
        Object.assign(
          estimate.payments.find((p) => p.id === where.id),
          data,
        ),
      ),
    },
    orderSequence: { create: jest.fn(async () => ({ id: 22 })) },
    orderStatus: {
      findUnique: jest.fn(async () => ({ id: 1, name: 'Pending' })),
    },
    estimateStatus: {
      findUnique: jest.fn(async () => ({ id: 2, name: 'Ordered' })),
    },
    order: {
      create: jest.fn(async ({ data }) => {
        estimate.order = { id: 22, ...data, status: { name: 'Pending' } };
        return estimate.order;
      }),
      findUnique: jest.fn(async () => estimate.order),
    },
    eventLog: { create: jest.fn(async () => ({})) },
  };
  tx.payment.findUniqueOrThrow = tx.payment.findUnique;
  tx.$transaction = jest.fn(async (work) => work(tx));
  const notifications: any = {
    createAndSend: jest.fn(),
    createAndSendToRoles: jest.fn(),
  };
  const workflow = new InstallationWorkflowService(
    tx,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const config = {
    get: (key: string) =>
      key === 'STRIPE_SECRET_KEY'
        ? 'sk_test_simulated'
        : key === 'FRONTEND_URL'
          ? 'http://localhost:3000'
          : undefined,
  } as ConfigService;
  const service = new PaymentsService(tx, config, workflow, notifications);
  const stripe = (service as any).stripe as Stripe;
  const createSession = jest
    .spyOn(stripe.checkout.sessions, 'create')
    .mockResolvedValue({
      id: 'cs_simulated',
      url: 'https://checkout.stripe.com/simulated',
    } as Stripe.Response<Stripe.Checkout.Session>);
  const actor: any = { id: 7, role: { name: role } };
  const manual = (sequence: number, admin = true) =>
    service.recordManualPayment({
      estimateId: 1,
      type: PaymentType.INSTALLMENT,
      sequence,
      method: PaymentMethod.CASH,
      fundsVerified: true,
      reference: `receipt-${sequence}`,
      actor: admin ? { id: 1, role: { name: 'admin' } } : actor,
    });
  return { estimate, tx, service, workflow, actor, manual, createSession };
}

describe('Installment payment workflow', () => {
  it('blocks pickup at the API until the material release installment has been paid', async () => {
    const f = fixture({ deposit: 0, installation: 0 });
    await f.manual(1);
    f.estimate.order.status.name = 'Ready to pick up';
    f.estimate.order.fulfillmentMethod = 'CUSTOMER_PICKUP';
    f.tx.order.update = jest.fn(async () => ({
      status: { name: 'Picked up' },
    }));
    const deliveries = new DeliveriesService(
      f.tx,
      {} as never,
      {} as never,
      { createAndSend: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    const admin: any = { id: 1, role: { name: 'admin' } };
    await expect(deliveries.completePickup(22, admin)).rejects.toThrow(
      'release',
    );
    expect(f.tx.order.update).not.toHaveBeenCalled();
    await f.manual(2);
    await deliveries.completePickup(22, admin);
    expect(f.tx.order.update).toHaveBeenCalledTimes(1);
  });

  it('requires the release installment even when the separate delivery charge was paid', async () => {
    const f = fixture({ deposit: 0, installation: 0 });
    await f.manual(1);
    f.estimate.order.status.name = 'Ready to pick up';
    const delivery: any = {
      id: 5,
      sequence: 1,
      order: f.estimate.order,
      orderId: 22,
      type: 'STANDARD',
      status: 'READY_TO_SCHEDULE',
      payment: { status: 'PAID' },
    };
    f.tx.orderDelivery = {
      findUnique: jest.fn(async () => delivery),
      update: jest.fn(async () => ({
        ...delivery,
        status: 'SCHEDULED',
        updatedAt: new Date(),
      })),
    };
    const deliveries = new DeliveriesService(
      f.tx,
      {} as never,
      {} as never,
      { createAndSend: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    const admin: any = { id: 1, role: { name: 'admin' } };
    const when = {
      scheduledFor: new Date(Date.now() + 86400000).toISOString(),
    };
    await expect(deliveries.scheduleDelivery(5, when, admin)).rejects.toThrow(
      'release',
    );
    expect(f.tx.orderDelivery.update).not.toHaveBeenCalled();
    await f.manual(2);
    await deliveries.scheduleDelivery(5, when, admin);
    expect(f.tx.orderDelivery.update).toHaveBeenCalledTimes(1);
  });
  it.each([RegisterUserDto, UpdateProfileDto])(
    'prevents assigning a payment plan through public registration or self-service profile',
    async (metatype) => {
      const pipe = new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      await expect(
        pipe.transform({ paymentPlanId: 3 }, { type: 'body', metatype }),
      ).rejects.toMatchObject({
        response: {
          message: expect.arrayContaining([
            'property paymentPlanId should not exist',
          ]),
        },
      });
    },
  );

  it('adds an approved price change inside the existing agreement transaction', async () => {
    const f = fixture();
    await f.manual(1);
    f.tx.estimateAgreement = { findMany: jest.fn(async () => []) };
    f.tx.$queryRaw.mockImplementation(async () => [
      { id: 1, paymentPlanSnapshot: f.estimate.paymentPlanSnapshot },
    ]);
    await withAgreementTransaction(f.tx, 1, async () => {
      f.estimate.installationJob.quotes[0].total = decimal(2300);
    });
    expect(f.estimate.paymentPlanSnapshot.adjustments[0].amount).toBe('300.00');
    expect(buildPaymentSchedule(f.estimate)?.balance).toBe('5300.00');
  });
  it('creates one order after the first confirmed payment, collects 90% before work, then closes the final balance', async () => {
    const f = fixture();
    await f.manual(1);
    expect(f.tx.order.create).toHaveBeenCalledTimes(1);
    expect(f.estimate.payments[1].baseAmount.toFixed(2)).toBe('4750.00');
    expect(f.estimate.order.price.toFixed(2)).toBe('8000.00');
    expect(f.estimate.installationJob.status).toBe('MATERIAL_PAID');
    f.estimate.order.status.name = 'Ready to pick up';
    await refreshScheduledInstallation(f.tx, 1);
    expect(f.estimate.installationJob.status).toBe(
      'INSTALLATION_PAYMENT_PENDING',
    );
    await f.manual(2);
    expect(f.estimate.installationJob.status).toBe('INSTALLATION_PAID');
    expect(buildPaymentSchedule(f.estimate)?.balance).toBe('1000.00');
    await expect(f.manual(3)).rejects.toThrow('next');
    f.estimate.order.status.name = 'Installed';
    f.estimate.installationJob.status = 'COMPLETED';
    await f.manual(3);
    expect(buildPaymentSchedule(f.estimate)?.balance).toBe('0.00');
    expect(f.estimate.installationJob.status).toBe('COMPLETED');
    expect(f.tx.order.create).toHaveBeenCalledTimes(1);
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('uses the same installment principal for card checkout and adds its card fee separately', async () => {
    const f = fixture();
    await f.service.createCheckoutSessionForEstimate({
      estimateId: 1,
      type: PaymentType.INSTALLMENT,
      sequence: 1,
      user: f.actor,
    });
    const p = f.estimate.payments[1];
    expect(p.baseAmount.toFixed(2)).toBe('4750.00');
    expect(p.amount.toFixed(2)).toBe('4892.50');
    expect(f.tx.order.create).not.toHaveBeenCalled();
    const session: any = {
      id: 'cs_simulated',
      payment_status: 'paid',
      amount_total: 489250,
      currency: 'usd',
    };
    await (f.service as any).processPaidCheckoutSession(f.tx, session);
    await (f.service as any).processPaidCheckoutSession(f.tx, session);
    expect(f.tx.order.create).toHaveBeenCalledTimes(1);
    expect(buildPaymentSchedule(f.estimate)?.paid).toBe('5000.00');
    const lock = f.tx.$queryRaw.mock.invocationCallOrder[0];
    const read = f.tx.estimate.findUnique.mock.invocationCallOrder[0];
    expect(lock).toBeLessThan(read);
  });

  it('requires client material acceptance for the first installment but not later ones', async () => {
    const f = fixture({
      role: 'client',
      mode: '',
      deposit: 0,
      installation: 0,
    });
    await expect(
      f.service.createCheckoutSessionForEstimate({
        estimateId: 1,
        type: PaymentType.INSTALLMENT,
        user: f.actor,
      }),
    ).rejects.toThrow('Review and accept');
    expect(f.createSession).not.toHaveBeenCalled();
    await f.service.createCheckoutSessionForEstimate({
      estimateId: 1,
      type: PaymentType.INSTALLMENT,
      user: f.actor,
      materialAccepted: true,
    });
    expect(f.estimate.payments[0].materialAcceptedAt).toBeInstanceOf(Date);
    expect(f.estimate.payments[0].materialAcceptanceText).toContain(
      'products, dimensions',
    );
    await (f.service as any).processPaidCheckoutSession(f.tx, {
      id: 'cs_simulated',
      payment_status: 'paid',
      amount_total: 412000,
      currency: 'usd',
    });
    f.estimate.order.status.name = 'Ready to pick up';
    await f.service.createCheckoutSessionForEstimate({
      estimateId: 1,
      type: PaymentType.INSTALLMENT,
      sequence: 2,
      user: f.actor,
    });
    expect(f.estimate.payments[1].materialAcceptedAt).toBeUndefined();
    expect(f.createSession).toHaveBeenCalledTimes(2);
  });

  it('enforces owners, internal dealer payment channels, and manual payment permissions', async () => {
    const f = fixture();
    await expect(
      f.workflow.getPaymentContext(
        1,
        PaymentType.INSTALLMENT,
        1,
        undefined,
        { id: 99, role: { name: 'dealer' } },
        f.tx,
      ),
    ).rejects.toThrow('not found');
    await expect(f.manual(1, false)).rejects.toThrow('Only administrators');
    const internal = fixture({ mode: 'INTERNAL' });
    await expect(
      internal.service.createCheckoutSessionForEstimate({
        estimateId: 1,
        type: PaymentType.INSTALLMENT,
        user: internal.actor,
      }),
    ).rejects.toThrow('final customer');
    await internal.manual(1, false);
    expect(internal.estimate.payments[1].payerType).toBe('CUSTOMER');
    await expect(
      f.service.getPublicPaymentContext('external-token'),
    ).resolves.toEqual({
      enabled: false,
      payment: null,
      status: 'not_applicable',
    });
  });

  it('requires complete customer data at payment and rejects legacy whole-material checkout for a new plan', async () => {
    const f = fixture();
    f.estimate.customerStreet = null;
    await expect(f.manual(1)).rejects.toThrow('customer');
    await expect(
      f.workflow.getPaymentContext(
        1,
        PaymentType.MATERIAL,
        1,
        undefined,
        f.actor,
        f.tx,
      ),
    ).rejects.toThrow('payment schedule');
  });

  it('confirms an order with a zero installment when the deposit covers it and carries the remainder', async () => {
    const f = fixture({ material: 300, installation: 100 });
    await f.manual(1);
    expect(f.estimate.payments[1].baseAmount.toFixed(2)).toBe('0.00');
    expect(f.tx.order.create).toHaveBeenCalledTimes(1);
    expect(buildPaymentSchedule(f.estimate)?.rows[1].balance).toBe('110.00');
  });

  it('does not overwrite a refunded installment or resurrect it on a duplicate Stripe event', async () => {
    const f = fixture();
    f.estimate.payments.push({
      id: 42,
      idEst: 1,
      type: 'INSTALLMENT',
      sequence: 1,
      status: 'REFUNDED',
      baseAmount: decimal(4750),
      amount: decimal(4750),
      stripeSessionId: 'cs_refunded',
    });
    await expect(
      f.service.createCheckoutSessionForEstimate({
        estimateId: 1,
        type: PaymentType.INSTALLMENT,
        sequence: 1,
        user: f.actor,
      }),
    ).rejects.toThrow('refunded');
    await (f.service as any).processPaidCheckoutSession(f.tx, {
      id: 'cs_refunded',
      payment_status: 'paid',
      amount_total: 475000,
      currency: 'usd',
    });
    expect(f.tx.payment.update).not.toHaveBeenCalled();
    expect(f.tx.order.create).not.toHaveBeenCalled();
  });

  it('combines two initial bases so an order cannot be placed paying only one of them', () => {
    const definition: PlanDefinition = {
      ...plan,
      withInstallation: [
        { milestone: 'ORDER', basis: 'MATERIAL', percent: 50 },
        { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 },
        { milestone: 'ORDER', basis: 'INSTALLATION', percent: 50 },
        { milestone: 'COMPLETE', basis: 'INSTALLATION', percent: 50 },
      ],
    };
    const rows = planRows(
      { version: 1, planId: 1, name: 'Combined', definition },
      {
        material: '8000.00',
        installation: '2000.00',
        permit: '0.00',
        city: '0.00',
      },
      true,
    );
    expect(rows.map((r) => r.amount)).toEqual([
      '5000.00',
      '4000.00',
      '1000.00',
    ]);
    expect(rows[0].sequence).toBe(1);
  });

  it.each(['Installed', 'Installation in progress', 'Ready to pick up'])(
    'restores operational state after an approved price adjustment (%s)',
    async (status) => {
      const f = fixture({ deposit: 0 });
      await f.manual(1);
      f.estimate.order.status.name = status;
      f.estimate.payments.push({
        type: 'INSTALLMENT',
        sequence: 2,
        status: 'PAID',
        baseAmount: '4000.00',
      });
      f.estimate.installationJob.status = 'INSTALLATION_PAYMENT_PENDING';
      f.estimate.installationJob.appointments = [{ status: 'ACCEPTED' }];
      await refreshScheduledInstallation(f.tx, 1);
      expect(f.estimate.installationJob.status).toBe(
        status === 'Installed'
          ? 'COMPLETED'
          : status === 'Installation in progress'
            ? 'IN_PROGRESS'
            : 'SCHEDULED',
      );
    },
  );
});
