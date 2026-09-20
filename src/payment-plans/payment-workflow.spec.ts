import { reconcileChargeRefunds, recordStripeReceipt, refreshPaymentAccounting } from '@/payments/payment-ledger';
import { attachLedgerStore } from '@/payments/testing/ledger-store';
import { ConfigService } from '@nestjs/config';
import { PaymentMethod, PaymentType, Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { PaymentsService } from '@/payments/payments.service';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import {
  buildPaymentSchedule,
  refreshScheduledInstallation,
  synchronizeScheduleChanges,
} from './payment-schedule';
import { planRows, PlanDefinition } from './payment-plan';
import { ValidationPipe } from '@nestjs/common';
import { RegisterUserDto } from '@/auth/dto/register-user.dto';
import { UpdateProfileDto } from '@/auth/dto/update-profile.dto';
import { withAgreementTransaction } from '@/contracts/agreement-content';
import { PaymentsController } from '@/payments/payments.controller';
import { CreatePublicCheckoutSessionDto } from '@/payments/dto/create-public-checkout-session.dto';
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
    publicTokenEnabled: true,
    publicToken: 'customer-link',
    publicTotalToken: 'customer-total-link',
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
    estimateAgreement: { findFirst: jest.fn().mockResolvedValue(null) },
    estimate: {
      findUnique: jest.fn(async (args) => {
        const filter = args?.include?.payments?.where;
        return filter ? { ...estimate, payments: estimate.payments.filter(p => p.type === filter.type &&
          (!filter.sequence || p.sequence === filter.sequence)).sort((a, b) => b.sequence - a.sequence).slice(0, 1) } : estimate;
      }),
      findUniqueOrThrow: jest.fn(async () => estimate),
      findFirst: jest.fn(async ({ where }) =>
        where.dealerModeSnapshot === 'INTERNAL' && mode !== 'INTERNAL'
          ? null
          : estimate,
      ),
      update: jest.fn(async ({ data }) => {
        Object.assign(estimate, data);
        if (data.statusId === 2) estimate.status = { name: 'Ordered' };
        if (data.statusId === 3) estimate.status = { id: 3, name: 'Pending order review' };
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
      findMany: jest.fn(async ({ where = {} }) => estimate.payments.filter(p =>
        (where.idEst == null || p.idEst === where.idEst) &&
        (where.type == null || p.type === where.type) &&
        (where.status == null || p.status === where.status) &&
        (where.stripeSessionId == null || (typeof where.stripeSessionId === 'string' ? p.stripeSessionId === where.stripeSessionId : Boolean(p.stripeSessionId)))
      ).map(p => ({ ...p, estimate }))),
      updateMany: jest.fn(async ({ where, data }) => {
        const rows = estimate.payments.filter(p => p.stripeSessionId === where.stripeSessionId &&
          !(where.status?.notIn ?? []).includes(p.status));
        rows.forEach(p => Object.assign(p, data));
        return { count: rows.length };
      }),
      findUnique: jest.fn(async ({ where }) => {
        const key = where.idEst_type_sequence;
        const p = estimate.payments.find((p) =>
          key
            ? p.type === key.type && p.sequence === key.sequence
            : where.stripeSessionId
              ? p.stripeSessionId === where.stripeSessionId
              : where.deliveryId ? p.deliveryId === where.deliveryId : p.id === where.id,
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
        const p = { id: 40 + estimate.payments.length, currency: 'usd', refundedAmount: decimal(0), refundCreditAmount: decimal(0), refundReviewBaseAmount: decimal(0), refundReviewPending: false, ...create };
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
      upsert: jest.fn(async () => ({ id: 3, name: 'Pending order review' })),
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
  const ledger = attachLedgerStore(tx, () => estimate.payments);
  tx.order.findUniqueOrThrow = tx.order.findUnique;
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
  jest.spyOn(workflow, 'refreshUnpaidDealerMeasurements').mockResolvedValue(undefined);
  const config = {
    get: (key: string) =>
      key === 'STRIPE_SECRET_KEY'
        ? 'sk_test_simulated'
        : key === 'STRIPE_WEBHOOK_SECRET' ? 'whsec_test'
        : key === 'FRONTEND_URL'
          ? 'http://localhost:3000'
          : undefined,
  } as ConfigService;
  const service = new PaymentsService(tx, config, workflow, notifications);
  const stripe = (service as any).stripe as Stripe;
  const refunds = jest.spyOn(stripe.refunds, 'list').mockResolvedValue({ data: [], has_more: false } as any);
  const intent = jest.spyOn(stripe.paymentIntents, 'retrieve').mockImplementation(async (id: string) => {
    const sessionId = id.startsWith('pi_cs_') ? id.slice(3) : 'cs_simulated';
    const group = estimate.payments.filter(p => p.stripeSessionId === sessionId);
    return { id, status: 'succeeded', latest_charge: { id: `ch_${id}`, payment_intent: id, paid: true, captured: true,
      currency: 'usd', created: 1700000000, amount_captured: group.reduce((sum, p) => sum + Math.round(Number(p.amount) * 100), 0),
      payment_method_details: { type: 'card', card: { brand: 'visa' } } } } as any;
  });
  const createSession = jest
    .spyOn(stripe.checkout.sessions, 'create')
    .mockResolvedValue({
      id: 'cs_simulated',
      url: 'https://checkout.stripe.com/simulated',
    } as Stripe.Response<Stripe.Checkout.Session>);
  const actor: any = { id: 7, role: { name: role } };
  const approve = () => service.approveOrder(1, { id: 1, role: { name: "admin" } });
  const manual = (sequence: number, admin = true, cityFeeAccepted = false) =>
    service.recordManualPayment({
      estimateId: 1,
      type: PaymentType.INSTALLMENT,
      sequence,
      method: PaymentMethod.CASH,
      fundsVerified: true,
      cityFeeAccepted,
      reference: `receipt-${sequence}`,
      actor: admin ? { id: 1, role: { name: 'admin' } } : actor,
    });
  return { ledger, refunds, intent, stripe, estimate, tx, service, workflow, actor, manual, approve, createSession };
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
      {} as never,
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
    f.estimate.payments.push({ id: 98, type: 'DELIVERY', sequence: 1, deliveryId: 5, status: 'PAID', baseAmount: decimal(100) });
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
      {} as never,
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
  it('creates one order after administrative review, collects 90% before work, then closes the final balance', async () => {
    const f = fixture();
    await f.manual(1);
    expect(f.estimate.order).toBeNull();
    expect(f.estimate.status.name).toBe("Pending order review");
    await f.approve();
    await f.approve();
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
    await expect(f.manual(3)).rejects.toThrow('not available');
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
      payment_status: 'paid', payment_intent: 'pi_cs_simulated',
      amount_total: 489250,
      currency: 'usd',
    };
    await (f.service as any).processPaidCheckoutSession(f.tx, session);
    await (f.service as any).processPaidCheckoutSession(f.tx, session);
    expect(f.tx.order.create).not.toHaveBeenCalled();
    expect(f.estimate.status.name).toBe("Pending order review");
    await f.approve();
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
      payment_status: 'paid', payment_intent: 'pi_cs_simulated',
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

  it('submits for review with a zero installment when the deposit covers it and carries the remainder', async () => {
    const f = fixture({ material: 300, installation: 100 });
    await f.manual(1);
    expect(f.estimate.payments[1].baseAmount.toFixed(2)).toBe('0.00');
    expect(f.estimate.order).toBeNull();
    await f.approve();
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
      stripeSessionId: 'cs_refunded', currency: 'usd', surchargeAmount: decimal(0),
    });
    await expect(
      f.service.createCheckoutSessionForEstimate({
        estimateId: 1,
        type: PaymentType.INSTALLMENT,
        sequence: 1,
        user: f.actor,
      }),
    ).rejects.toThrow('reconciliation');
    f.refunds.mockResolvedValue({ data: [{ id: 're_old', charge: 'ch_pi_cs_refunded', amount: 475000, currency: 'usd', status: 'succeeded', created: 1700000100 }], has_more: false } as any);
    await (f.service as any).processPaidCheckoutSession(f.tx, {
      id: 'cs_refunded',
      payment_status: 'paid', payment_intent: 'pi_cs_refunded',
      amount_total: 475000,
      currency: 'usd',
    });
    expect(f.estimate.payments.find(p => p.id === 42)).toMatchObject({ status: 'REFUNDED', refundReviewPending: true });
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
      await f.approve();
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


describe('Order review and permit installments', () => {
  it.each([false, true])('requires admin review for all active installations (company permit: %s)', async (withPermit) => {
    const f = fixture({ material: 1313.10 });
    if (withPermit) {
      f.estimate.installationJob.permit = { status: 'PAYMENT_PENDING', permitFeeSnapshot: decimal(1500), cityFee: null };
      f.estimate.installationJob.status = 'PERMIT_PAYMENT_PENDING';
    }
    expect(buildPaymentSchedule(f.estimate)?.next?.balance).toBe(withPermit ? '2156.55' : '1406.55');
    if (withPermit) await expect(f.workflow.getPaymentContext(1, PaymentType.PERMIT, 1, undefined, f.actor, f.tx)).rejects.toThrow('payment schedule');
    await f.manual(1);
    expect(f.estimate.status.name).toBe('Pending order review');
    expect(f.estimate.order).toBeNull();
    expect(f.tx.orderSequence.create).not.toHaveBeenCalled();
    expect(buildPaymentSchedule(f.estimate)?.next).toBeNull();
    await expect(f.manual(2)).rejects.toThrow('not available');
    for (const role of ['dealer', 'operator', 'client'] as const) {
      await expect(f.service.approveOrder(1, { id: 7, role: { name: role } })).rejects.toThrow('Only administrators');
    }
    await f.approve();
    await f.approve();
    expect(f.tx.order.create).toHaveBeenCalledTimes(1);
    expect(f.tx.orderSequence.create).toHaveBeenCalledTimes(1);
    expect(f.estimate.status.name).toBe('Ordered');
    expect(f.estimate.installationJob.status).toBe('MATERIAL_PAID');
    expect(f.tx.eventLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ entityType: 'Order', userId: 1 }) }));
    if (withPermit) expect(f.estimate.installationJob.permit.status).toBe('PAYMENT_PENDING');
  });

  it('keeps material-only order creation automatic', async () => {
    const f = fixture({ deposit: 0, installation: 0 });
    await f.manual(1);
    expect(f.estimate.status.name).toBe('Ordered');
    expect(f.tx.order.create).toHaveBeenCalledTimes(1);
    expect(f.tx.estimateStatus.upsert).not.toHaveBeenCalled();
  });

  it('blocks approval before payment, with an unapproved revision, and after a refund', async () => {
    const f = fixture();
    await expect(f.approve()).rejects.toThrow('not pending order review');
    await f.manual(1);
    f.estimate.units = 0;
    await expect(f.approve()).rejects.toThrow('At least one material unit');
    f.estimate.units = 2;
    f.estimate.installationJob.quotes[0].status = 'CUSTOMER_APPROVAL_PENDING';
    await expect(f.approve()).rejects.toThrow('Approve the installation quote');
    f.estimate.installationJob.quotes[0].status = 'APPROVED';
    Object.assign(f.estimate.payments[1], { status: 'REFUNDED', netPaidBaseAmount: decimal(0), refundReviewPending: true, refundReviewBaseAmount: decimal(4750) });
    await expect(f.approve()).rejects.toThrow();
    expect(f.tx.order.create).not.toHaveBeenCalled();
  });

  it('includes a known City Fee in 50/40/10 before the first payment', async () => {
    const f = fixture({ material: 1313.10 });
    f.estimate.installationJob.permit = { status: 'APPROVED', permitFeeSnapshot: decimal(1500), cityFee: decimal(300) };
    const schedule = buildPaymentSchedule(f.estimate)!;
    expect(schedule.rows.map(row => row.amount)).toEqual(['2556.55', '2045.24', '511.31']);
    expect(schedule.next?.balance).toBe('2306.55');
    await f.manual(1);
    expect(f.estimate.paymentPlanSnapshot.adjustments).toBeUndefined();
    expect(f.estimate.order).toBeNull();
  });

  it.each([false, true])('adds a late City Fee at 100% without rewriting paid installments (order exists: %s)', async (created) => {
    const f = fixture({ material: 1313.10 });
    f.estimate.installationJob.permit = { status: 'PAYMENT_PENDING', permitFeeSnapshot: decimal(1500), cityFee: null };
    await f.manual(1);
    if (created) await f.approve();
    const lockedRows = structuredClone(f.estimate.paymentPlanSnapshot.locked.rows);
    expect(buildPaymentSchedule(f.estimate)?.provisional).toBe(true);
    f.estimate.installationJob.permit.cityFee = decimal(300);
    f.estimate.installationJob.permit.status = 'APPROVED';
    await synchronizeScheduleChanges(f.tx, 1);
    await synchronizeScheduleChanges(f.tx, 1);
    expect(f.estimate.paymentPlanSnapshot.locked.rows).toEqual(lockedRows);
    expect(f.estimate.paymentPlanSnapshot.adjustments).toHaveLength(1);
    const schedule = buildPaymentSchedule(f.estimate)!;
    expect(schedule.total).toBe('5113.10');
    expect(schedule.paid).toBe('2406.55');
    expect(schedule.provisional).toBe(false);
    expect(schedule.next).toMatchObject({ kind: 'CITY_FEE', amount: '300.00', balance: '300.00' });
    await expect(f.manual(101)).rejects.toThrow('acceptance');
    await expect(f.service.createCheckoutSessionForEstimate({ estimateId: 1, type: PaymentType.INSTALLMENT, sequence: 101, user: f.actor })).rejects.toThrow('accept');
    expect(f.createSession).not.toHaveBeenCalled();
    await f.manual(101, true, true);
    expect(buildPaymentSchedule(f.estimate)?.paid).toBe('2706.55');
    expect(f.estimate.paymentPlanSnapshot.locked.rows).toEqual(lockedRows);
    expect(f.estimate.order === null).toBe(!created);
    expect(f.tx.eventLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ message: expect.stringContaining('City Fee adjustment #101: $300.00') }) }));
  });

  it('uses the first installment in the internal customer link even while the permit is pending', async () => {
    const f = fixture({ mode: 'INTERNAL', material: 1313.10 });
    f.estimate.installationJob.permit = { status: 'PAYMENT_PENDING', permitFeeSnapshot: decimal(1500), cityFee: null };
    f.estimate.installationJob.status = 'PERMIT_PAYMENT_PENDING';
    const context = await f.service.getPublicPaymentContext('customer-link');
    expect(context.payment).toMatchObject({ type: 'INSTALLMENT', sequence: 1, baseAmount: '2156.55' });
    await f.manual(1, false);
    const paid = await f.service.getPublicPaymentContext('customer-link');
    expect(paid).toMatchObject({ status: 'available', payment: { type: 'INSTALLMENT', sequence: 2 },
      schedule: { orderReviewPending: true, next: null, fullBalance: { amount: '2406.55', sequences: [2, 3] } } });
    expect(f.tx.order.create).not.toHaveBeenCalled();
  });
});

// Checkout real del servicio con persistencia y Stripe simulados: no realiza cobros externos.
describe('Selectable due installments', () => {
  async function readyFixture(internal = false) {
    const f = fixture({ material: 435.06, installation: 450, role: internal ? 'dealer' : 'client', mode: internal ? 'INTERNAL' : 'EXTERNAL' });
    Object.assign(f.estimate.user, { street: '123 Example Street', city: 'Miami', state: 'FL', postalCode: '33101' });
    f.estimate.installationJob.permit = { id: 6, status: 'SUBMITTED', permitFeeSnapshot: decimal(1500), cityFee: null };
    await f.manual(1);
    await f.approve();
    f.estimate.order.status.name = 'Ready to pick up';
    f.estimate.order.deliveries = [];
    f.estimate.order.extraCharges = [];
    f.estimate.installationJob.permit.status = 'APPROVED';
    f.estimate.installationJob.permit.cityFee = decimal(200);
    await synchronizeScheduleChanges(f.tx, 1);
    f.tx.globalParameter.findUnique.mockResolvedValue({ value: decimal(0) });
    const stripe = (f.service as any).stripe as Stripe;
    const sessions = new Map<string, any>();
    f.createSession.mockImplementation(async (params: any) => {
      const id = `cs_selection_${sessions.size + 1}`;
      const session = { id, url: `https://checkout.stripe.com/${id}`, status: 'open', payment_status: 'unpaid',
        amount_total: params.line_items.reduce((sum, line) => sum + line.price_data.unit_amount, 0), currency: 'usd',
        metadata: params.metadata, payment_intent: `pi_${id}`, ...params };
      sessions.set(id, session);
      return session;
    });
    const retrieve = jest.spyOn(stripe.checkout.sessions, 'retrieve').mockImplementation(async (id: string) => sessions.get(id));
    const expire = jest.spyOn(stripe.checkout.sessions, 'expire').mockImplementation(async (id: string) => {
      sessions.get(id).status = 'expired';
      return sessions.get(id);
    });
    const checkout = (sequences: number[], cityFeeAccepted?: boolean) => f.service.createCheckoutSessionForEstimate({
      estimateId: 1, type: PaymentType.INSTALLMENT, sequences, cityFeeAccepted, user: f.actor,
      ...(internal ? { publicToken: 'customer-link' } : {}),
    });
    const confirm = async (id: string) => {
      const session = sessions.get(id);
      session.status = 'complete'; session.payment_status = 'paid';
      return (f.service as any).processPaidCheckoutSession(f.tx, session);
    };
    return { ...f, stripe, sessions, checkout, confirm, retrieve, expire };
  }

  describe('H06/H09 — Independent delivery, extras and public selections', () => {
    async function mixedFixture() {
      const f = await readyFixture(true);
      const delivery = { id: 71, orderId: 22, sequence: 1, status: 'PAYMENT_DUE', total: decimal(150), type: 'STANDARD' };
      const delivery2 = { id: 72, orderId: 22, sequence: 2, status: 'PAYMENT_DUE', total: decimal(50), type: 'STANDARD' };
      const extra = { id: 81, orderId: 22, sequence: 1, status: 'PAYMENT_DUE', total: decimal(25) };
      f.estimate.order.deliveries = [delivery, delivery2];
      f.estimate.order.extraCharges = [extra];
      const store = (rows: any[]) => ({
        findFirst: jest.fn(async ({ where }) => rows.find(r => r.orderId === where.orderId && r.sequence === where.sequence) ?? null),
        findUnique: jest.fn(async ({ where }) => {
          const row = rows.find(r => r.id === where.id);
          return row ? { ...row, order: f.estimate.order, payment: f.estimate.payments.find(p => p.deliveryId === row.id || p.extraChargeId === row.id) } : null;
        }),
        update: jest.fn(async ({ where, data }) => Object.assign(rows.find(r => r.id === where.id), data, { updatedAt: new Date() })),
      });
      f.tx.orderDelivery = store([delivery, delivery2]);
      f.tx.orderExtraCharge = store([extra]);
      const select = (items: Array<{ type: PaymentType; sequence: number }>, expectedBalance: number, cityFeeAccepted?: boolean) =>
        f.service.createCheckoutSessionForPublicToken({ token: 'customer-link', items, expectedBalance, cityFeeAccepted });
      return { ...f, delivery, delivery2, extra, select };
    }
    const release = { type: PaymentType.INSTALLMENT, sequence: 2 };
    const city = { type: PaymentType.INSTALLMENT, sequence: 101 };
    const delivery = { type: PaymentType.DELIVERY, sequence: 1 };
    const extra = { type: PaymentType.EXTRA, sequence: 1 };

    it('validates nested item types, sequences and forbids caller-provided charge amounts', async () => {
      const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
      const transform = (body: unknown) => pipe.transform(body, { type: 'body', metatype: CreatePublicCheckoutSessionDto });
      await expect(transform({ items: [delivery, extra], expectedBalance: 175 })).resolves.toMatchObject({ items: [delivery, extra] });
      for (const item of [{ type: 'OTHER', sequence: 1 }, { type: 'DELIVERY', sequence: -1 },
        { type: 'EXTRA', sequence: 1.1 }, { type: 'DELIVERY', sequence: 1, amount: 1 }, 'DELIVERY']) {
        await expect(transform({ items: [item], expectedBalance: 1 })).rejects.toThrow();
      }
    });

    it('lists every independent eligible charge and includes upcoming installments in full balance', async () => {
      const f = await mixedFixture();
      const context = await f.service.getPublicPaymentContext('customer-link');
      expect(context.payments).toEqual(expect.arrayContaining([
        expect.objectContaining({ ...release, baseAmount: '954.02', advanceOnly: false }),
        expect.objectContaining({ ...city, baseAmount: '200.00', requiresCityFeeAcceptance: true }),
        expect.objectContaining({ ...delivery, baseAmount: '150.00' }),
        expect.objectContaining({ type: 'DELIVERY', sequence: 2, baseAmount: '50.00' }),
        expect.objectContaining({ ...extra, baseAmount: '25.00' }),
        expect.objectContaining({ type: 'INSTALLMENT', sequence: 3, baseAmount: '238.51', advanceOnly: true }),
      ]));
      expect(context.fullBalance?.amount).toBe('1617.53');
      expect(context.fullBalance?.items).toHaveLength(6);
    });

    it('honors an explicit delivery request instead of charging the outstanding installment', async () => {
      const f = await mixedFixture();
      const controller = new PaymentsController(f.service);
      const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
      const dto = await pipe.transform(delivery, { type: 'body', metatype: CreatePublicCheckoutSessionDto });
      await controller.createPublicCheckoutSession('customer-link', dto);
      expect(f.sessions.get('cs_selection_1').amount_total).toBe(15000);
      await f.confirm('cs_selection_1');
      expect(f.delivery.status).toBe('READY_TO_SCHEDULE');
      expect(buildPaymentSchedule(f.estimate)?.rows.find(r => r.sequence === 2)?.balance).toBe('954.02');
    });

    it.each([
      { items: [delivery], amount: 150 },
      { items: [extra], amount: 25 },
      { items: [delivery, extra], amount: 175 },
      { items: [release, delivery, extra], amount: 1129.02 },
      { items: [city, delivery, extra], amount: 375 },
    ])('pays the selected concepts only: $items', async ({ items, amount }) => {
      const f = await mixedFixture();
      await f.select(items, amount, items.some(item => item.sequence === 101));
      expect(f.sessions.get('cs_selection_1').amount_total).toBe(Math.round(amount * 100));
      await f.confirm('cs_selection_1');
      const paid = f.estimate.payments.filter(p => p.stripeSessionId === 'cs_selection_1');
      expect(paid).toHaveLength(items.length);
      expect(paid.every(p => p.status === 'PAID')).toBe(true);
      expect(paid.map(p => ({ type: p.type, sequence: p.sequence }))).toEqual(expect.arrayContaining(items));
      expect(f.ledger.receipts.filter(r => r.stripeSessionId === 'cs_selection_1')).toHaveLength(items.length);
      expect(f.delivery2.status).toBe('PAYMENT_DUE');
      const count = f.ledger.receipts.length;
      await f.confirm('cs_selection_1');
      expect(f.ledger.receipts).toHaveLength(count);
    });

    it('pays the full balance including both deliveries, extras, City Fee and the final installment', async () => {
      const f = await mixedFixture();
      await expect(f.service.createCheckoutSessionForPublicToken({ token: 'customer-link', payFullBalance: true, expectedBalance: 1617.53 })).rejects.toThrow('accept the City Fee');
      await f.service.createCheckoutSessionForPublicToken({ token: 'customer-total-link', payFullBalance: true, expectedBalance: 1617.53, cityFeeAccepted: true });
      expect(f.sessions.get('cs_selection_1').amount_total).toBe(161753);
      await f.confirm('cs_selection_1');
      expect(buildPaymentSchedule(f.estimate)?.balance).toBe('0.00');
      expect(f.delivery.status).toBe('READY_TO_SCHEDULE');
      expect(f.delivery2.status).toBe('READY_TO_SCHEDULE');
      expect(f.extra.status).toBe('PAID');
      expect(f.estimate.installationJob.completedAt).toBeUndefined();
      expect(await f.service.getPublicPaymentContext('customer-link')).toMatchObject({ status: 'complete', payment: null });
    });

    it('preserves legacy installation revisions when the previous sequence is paid', async () => {
      const f = await mixedFixture();
      f.estimate.paymentPlanSnapshot = null;
      f.estimate.payments.find(p => p.type === 'INSTALLATION_DEPOSIT').installationJobId = 3;
      f.estimate.installationJob.status = 'INSTALLATION_PAYMENT_PENDING';
      Object.assign(f.estimate.installationJob.quotes[0], { version: 2, total: decimal(500) });
      f.estimate.payments.push({ id: 95, idEst: 1, installationJobId: 3, type: 'INSTALLATION', sequence: 1,
        status: 'PAID', baseAmount: decimal(100), amount: decimal(100) });
      const context = await f.service.getPublicPaymentContext('customer-link');
      expect(context.payments).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'INSTALLATION', sequence: 2, baseAmount: '150.00' }),
      ]));
      await f.select([{ type: PaymentType.INSTALLATION, sequence: 2 }], 150);
      expect(f.sessions.get('cs_selection_1').amount_total).toBe(15000);
    });

    it('still offers full balance when only independent charges remain', async () => {
      const f = await mixedFixture();
      await f.manual(2); await f.manual(101, true, true);
      f.estimate.order.status.name = 'Installed'; await f.manual(3);
      expect((await f.service.getPublicPaymentContext('customer-link')).fullBalance?.amount).toBe('225.00');
      await f.service.createCheckoutSessionForPublicToken({ token: 'customer-link', payFullBalance: true, expectedBalance: 225 });
      expect(f.sessions.get('cs_selection_1').amount_total).toBe(22500);
    });

    it('resumes the exact mixed selection and closes it before opening a different selection', async () => {
      const f = await mixedFixture();
      await f.select([delivery, extra], 175);
      await f.select([extra, delivery], 175);
      expect(f.createSession).toHaveBeenCalledTimes(1);
      const context = await f.service.getPublicPaymentContext('customer-link');
      expect(context.checkouts?.[0]).toMatchObject({ baseAmount: '175.00', items: [delivery, extra] });
      expect(context.installmentCheckouts).toHaveLength(0);
      await f.select([extra], 25);
      expect(f.sessions.get('cs_selection_1').status).toBe('expired');
      expect(f.sessions.get('cs_selection_2').amount_total).toBe(2500);
      expect(f.estimate.payments.find(p => p.type === 'DELIVERY').status).toBe('CANCELED');
      await f.confirm('cs_selection_2');
      expect(f.extra.status).toBe('PAID');
      expect(f.delivery.status).toBe('PAYMENT_DUE');
    });

    it('rejects changed amounts, duplicates, unknown items and partial advance payments', async () => {
      const f = await mixedFixture();
      for (const [items, amount] of [
        [[delivery, delivery], 300], [[{ ...delivery, sequence: 999 }], 150],
        [[{ type: PaymentType.INSTALLMENT, sequence: 3 }], 238.51], [[delivery], 149.99],
      ] as Array<[Array<{ type: PaymentType; sequence: number }>, number]>) {
        await expect(f.select(items, amount)).rejects.toThrow();
      }
      await expect(f.service.createCheckoutSessionForPublicToken({ token: 'customer-link', items: [delivery], type: 'DELIVERY', expectedBalance: 150 })).rejects.toThrow('either');
      f.delivery.total = decimal(151);
      await expect(f.select([delivery], 150)).rejects.toThrow('balance changed');
      await expect(f.service.createCheckoutSessionForPublicToken({ token: 'customer-link', payFullBalance: true, expectedBalance: 1617.53, cityFeeAccepted: true })).rejects.toThrow('balance changed');
      expect(f.createSession).not.toHaveBeenCalled();
    });

    it('keeps unrelated charges available while one refund is under review', async () => {
      const f = await mixedFixture();
      await f.select([delivery], 150); await f.confirm('cs_selection_1');
      const payment = f.estimate.payments.find(p => p.type === 'DELIVERY');
      payment.refundReviewPending = true;
      const context = await f.service.getPublicPaymentContext('customer-link');
      expect(context.payments?.some(p => p.type === 'EXTRA')).toBe(true);
      expect(context.payments?.some(p => p.type === 'DELIVERY' && p.sequence === 1)).toBe(false);
      expect(context.fullBalance).toBeNull();
      await f.select([extra], 25);
      expect(f.sessions.get('cs_selection_2').amount_total).toBe(2500);
    });

    it('preserves per-item accounting and idempotency on a partial refund of mixed charges', async () => {
      const f = await mixedFixture();
      await f.select([release, delivery, extra], 1129.02); await f.confirm('cs_selection_1');
      const charge = (await f.stripe.paymentIntents.retrieve('pi_cs_selection_1')).latest_charge as any;
      const refund: any = { id: 're_mixed', charge: charge.id, amount: 10000, currency: 'usd', status: 'succeeded', created: 1700000100 };
      await reconcileChargeRefunds(f.tx, charge, [refund]);
      await reconcileChargeRefunds(f.tx, charge, [refund]);
      const allocations = f.ledger.allocations.filter(a => a.refundId === refund.id);
      expect(allocations).toHaveLength(3);
      expect(allocations.reduce((sum, a) => sum + Number(a.amount), 0)).toBeCloseTo(100, 2);
      const group = f.estimate.payments.filter(p => p.stripeSessionId === 'cs_selection_1');
      expect(group.every(p => p.refundReviewPending)).toBe(true);
      expect(buildPaymentSchedule(f.estimate)?.canRelease).toBe(false);
      await f.service.reviewRefund(1, refund.id, { note: 'Amounts remain due after refund', allocations: allocations.map(a => ({ id: a.id, creditAmount: 0 })) }, { id: 1, role: { name: 'admin' } });
      const payment = f.estimate.payments.find(p => p.type === 'DELIVERY');
      const balance = Number(payment.originalBaseAmount) - Number(payment.netPaidBaseAmount);
      expect((await f.service.getPublicPaymentContext('customer-link')).payments).toEqual(expect.arrayContaining([
        expect.objectContaining({ ...delivery, baseAmount: balance.toFixed(2) }),
      ]));
      await f.select([delivery], Number(balance.toFixed(2))); await f.confirm('cs_selection_2');
      expect(Number(payment.netPaidBaseAmount)).toBe(150);
      expect(f.delivery.status).toBe('READY_TO_SCHEDULE');
      expect(f.ledger.refunds).toHaveLength(1);
    });

    it('permits pickup after release payment while the independent City Fee remains pending', async () => {
      const f = await mixedFixture();
      await f.select([release], 954.02); await f.confirm('cs_selection_1');
      f.estimate.order.fulfillmentMethod = 'CUSTOMER_PICKUP';
      f.tx.order.update = jest.fn(async ({ data }) => Object.assign(f.estimate.order, data));
      const deliveries = new DeliveriesService(f.tx, {} as never, {} as never,
        { createAndSend: jest.fn() } as never, { log: jest.fn() } as never, {} as never);
      await deliveries.completePickup(22, { id: 1, role: { name: 'admin' } });
      expect(f.tx.order.update).toHaveBeenCalled();
      expect(buildPaymentSchedule(f.estimate)?.rows.find(r => r.sequence === 101)?.balance).toBe('200.00');
    });

    it('uses the same release rule when scheduling a paid delivery', async () => {
      const f = await mixedFixture();
      await f.select([release, delivery], 1104.02); await f.confirm('cs_selection_1');
      const deliveries = new DeliveriesService(f.tx, {} as never, {} as never,
        { createAndSend: jest.fn() } as never, { log: jest.fn() } as never, {} as never);
      await deliveries.scheduleDelivery(71, { scheduledFor: new Date(Date.now() + 86400000).toISOString() }, { id: 1, role: { name: 'admin' } });
      expect(f.delivery.status).toBe('SCHEDULED');
      expect(buildPaymentSchedule(f.estimate)?.rows.find(r => r.sequence === 101)?.balance).toBe('200.00');
    });
  });

  describe('Voluntary full balance payments', () => {
    const fullCheckout = (f: Awaited<ReturnType<typeof readyFixture>>, expectedBalance = 1392.53, cityFeeAccepted = true) =>
      f.service.createCheckoutSessionForEstimate({ estimateId: 1, type: PaymentType.INSTALLMENT,
        payFullBalance: true, expectedBalance, cityFeeAccepted, user: f.actor });

    it('pays due and future installments once without completing the installation or delivering materials', async () => {
      const f = await readyFixture();
      expect(buildPaymentSchedule(f.estimate)?.fullBalance).toEqual({ amount: '1392.53', sequences: [101, 2, 3] });
      await fullCheckout(f);
      const session = f.sessions.get('cs_selection_1');
      expect(session.amount_total).toBe(139253);
      expect(session.metadata.paymentScope).toBe('FULL_PROJECT_BALANCE');
      expect(session.line_items).toHaveLength(3);
      await f.confirm(session.id);
      const receipts = f.ledger.receipts.length;
      await f.confirm(session.id);
      expect(f.ledger.receipts).toHaveLength(receipts);
      expect(buildPaymentSchedule(f.estimate)).toMatchObject({ balance: '0.00', paid: '2585.06', next: null,
        fullBalance: null, canInstall: true, canRelease: true });
      expect(buildPaymentSchedule(f.estimate)?.rows.every(row => row.status === 'PAID')).toBe(true);
      expect(f.estimate.order.status.name).toBe('Ready to pick up');
      expect(f.estimate.installationJob.status).toBe('INSTALLATION_PAID');
      expect(f.estimate.installationJob.completedAt).toBeUndefined();
      await expect(fullCheckout(f)).rejects.toThrow('not available');
      expect(f.createSession).toHaveBeenCalledTimes(1);
    });

    it('charges only the remaining $438.51 after material release was paid separately', async () => {
      const f = await readyFixture();
      await f.manual(2);
      await fullCheckout(f, 438.51);
      expect(f.sessions.get('cs_selection_1').amount_total).toBe(43851);
      expect(f.estimate.payments.filter(p => p.stripeSessionId === 'cs_selection_1').map(p => p.sequence)).toEqual([3, 101]);
      await f.confirm('cs_selection_1');
      expect(buildPaymentSchedule(f.estimate)?.balance).toBe('0.00');
    });

    it('supports a third approved charge in the full balance', async () => {
      const f = await readyFixture();
      f.estimate.installationJob.quotes[0].total = decimal(750);
      await synchronizeScheduleChanges(f.tx, 1);
      await fullCheckout(f, 1692.53);
      expect(f.sessions.get('cs_selection_1').amount_total).toBe(169253);
      await f.confirm('cs_selection_1');
      expect(buildPaymentSchedule(f.estimate)?.balance).toBe('0.00');
    });

    it('keeps City Fee acceptance and upcoming-only selection safeguards', async () => {
      const f = await readyFixture();
      await expect(fullCheckout(f, 1392.53, false)).rejects.toThrow('accept the City Fee');
      await expect(f.checkout([3])).rejects.toThrow('not available');
      expect(f.createSession).not.toHaveBeenCalled();
    });

    it.each([undefined, NaN, -1, 0, 1392.531, 1392.52])('rejects missing, invalid or stale reviewed amount %s', async amount => {
      const f = await readyFixture();
      await expect(f.service.createCheckoutSessionForEstimate({ estimateId: 1, type: PaymentType.INSTALLMENT,
        payFullBalance: true, expectedBalance: amount, cityFeeAccepted: true, user: f.actor })).rejects.toThrow();
      expect(f.createSession).not.toHaveBeenCalled();
      expect(f.estimate.payments.filter(p => p.status === 'PENDING')).toHaveLength(0);
    });

    it('rejects mixing full balance with a partial selection or a different owner', async () => {
      const f = await readyFixture();
      for (const invalid of [{ sequence: 2 }, { sequences: [2] }, { type: PaymentType.EXTRA }, { user: { id: 99, role: { name: 'client' as const } } }]) {
        await expect(f.service.createCheckoutSessionForEstimate({ estimateId: 1, type: PaymentType.INSTALLMENT,
          payFullBalance: true, expectedBalance: 1392.53, cityFeeAccepted: true, user: f.actor, ...invalid })).rejects.toThrow();
      }
      expect(f.createSession).not.toHaveBeenCalled();
    });

    it('resumes the same full checkout and safely replaces overlapping selections', async () => {
      const f = await readyFixture();
      await f.checkout([2]);
      const full = await fullCheckout(f);
      expect(f.expire).toHaveBeenCalledWith('cs_selection_1');
      expect(await fullCheckout(f)).toEqual(full);
      expect(f.createSession).toHaveBeenCalledTimes(2);
      await f.checkout([2]);
      expect(f.expire).toHaveBeenCalledWith('cs_selection_2');
      expect(f.sessions.get('cs_selection_3').amount_total).toBe(95402);
      expect(f.estimate.payments.filter(p => [3, 101].includes(p.sequence)).every(p => p.status === 'CANCELED')).toBe(true);
    });

    it('reconciles a completed overlapping payment before another full checkout can charge it', async () => {
      const f = await readyFixture();
      await f.checkout([2]);
      Object.assign(f.sessions.get('cs_selection_1'), { status: 'complete', payment_status: 'paid' });
      expect((await fullCheckout(f)).url).toContain('/orders/22');
      expect(f.createSession).toHaveBeenCalledTimes(1);
      expect(buildPaymentSchedule(f.estimate)?.fullBalance?.amount).toBe('438.51');
      await expect(fullCheckout(f)).rejects.toThrow('balance changed');
    });

    it('applies a single card surcharge with exact cent allocation', async () => {
      const f = await readyFixture();
      f.tx.globalParameter.findUnique.mockResolvedValue({ value: decimal(0.03) });
      await fullCheckout(f);
      expect(f.sessions.get('cs_selection_1').amount_total).toBe(143431);
      expect(f.estimate.payments.filter(p => p.stripeSessionId === 'cs_selection_1')
        .reduce((sum, p) => sum.add(p.surchargeAmount), decimal(0)).toFixed(2)).toBe('41.78');
    });

    it('offers full balance through the customer link when only a future installment remains', async () => {
      const f = await readyFixture(true);
      f.estimate.publicTokenEnabled = true; f.estimate.publicToken = 'customer-link';
      await f.manual(2); await f.manual(101, true, true);
      expect(await f.service.getPublicPaymentContext('customer-link')).toMatchObject({ status: 'available',
        schedule: { next: null, fullBalance: { amount: '238.51', sequences: [3] } } });
      await f.service.createCheckoutSessionForPublicToken({ token: 'customer-link', payFullBalance: true, expectedBalance: 238.51 });
      expect(f.sessions.get('cs_selection_1').amount_total).toBe(23851);
      await f.confirm('cs_selection_1');
      expect(await f.service.getPublicPaymentContext('customer-link')).toMatchObject({ status: 'complete', payment: null });
      expect(f.estimate.installationJob.completedAt).toBeUndefined();
    });
  });

  it.each([2, 101])('allows either due installment first (%s), keeping the other balance outstanding', async sequence => {
    const f = await readyFixture();
    await f.checkout([sequence], sequence === 101 ? true : undefined);
    expect(f.createSession).toHaveBeenCalledTimes(1);
    expect(f.sessions.get('cs_selection_1').amount_total).toBe(sequence === 101 ? 20000 : 95402);
    await f.confirm('cs_selection_1');
    const schedule = buildPaymentSchedule(f.estimate)!;
    expect(schedule.rows.find(r => r.sequence === sequence)?.status).toBe('PAID');
    expect(schedule.rows.find(r => r.sequence === (sequence === 2 ? 101 : 2))?.status).toBe('DUE');
    expect(schedule.canRelease).toBe(sequence === 2);
    expect(schedule.canInstall).toBe(sequence === 2);
    expect(f.estimate.installationJob.status).toBe(sequence === 2 ? 'INSTALLATION_PAID' : 'INSTALLATION_PAYMENT_PENDING');
    expect(schedule.rows.find(r => r.sequence === 3)?.status).toBe('UPCOMING');
    await f.checkout([sequence === 2 ? 101 : 2], true);
    await f.confirm('cs_selection_2');
    expect(buildPaymentSchedule(f.estimate)?.canRelease).toBe(true);
    expect(buildPaymentSchedule(f.estimate)?.balance).toBe('238.51');
  });

  it('charges $1,154.02 once, credits both concepts, and processes repeated confirmations without duplicating payments', async () => {
    const f = await readyFixture();
    await f.checkout([101, 2], true);
    const session = f.sessions.get('cs_selection_1');
    expect(session.amount_total).toBe(115402);
    expect(session.line_items).toHaveLength(2);
    const selected = f.estimate.payments.filter(p => p.stripeSessionId === session.id);
    expect(selected.map(p => p.sequence)).toEqual([2, 101]);
    expect(selected.map(p => p.baseAmount.toFixed(2))).toEqual(['954.02', '200.00']);
    await f.confirm(session.id);
    const receipts = f.ledger.receipts.length;
    await f.confirm(session.id);
    expect(f.ledger.receipts).toHaveLength(receipts);
    expect(selected.every(p => p.status === 'PAID' && p.stripePaymentIntentId === session.payment_intent)).toBe(true);
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ total: '2585.06', paid: '2346.55', balance: '238.51', canRelease: true });
    expect(f.tx.order.create).toHaveBeenCalledTimes(1);
  });

  it.each([[102], [2, 102], [101, 102], [2, 101, 102]].map(sequences => ({ sequences })))('supports a third due adjustment and any combination: $sequences', async ({ sequences }) => {
    const f = await readyFixture();
    f.estimate.installationJob.quotes[0].total = decimal(750);
    await synchronizeScheduleChanges(f.tx, 1);
    expect(buildPaymentSchedule(f.estimate)?.rows.filter(r => r.status === 'DUE')).toHaveLength(3);
    const balances = { 2: 95402, 101: 20000, 102: 30000 };
    await f.checkout(sequences, sequences.includes(101));
    expect(f.sessions.get('cs_selection_1').amount_total).toBe(sequences.reduce((sum, seq) => sum + balances[seq], 0));
    await f.confirm('cs_selection_1');
    for (const sequence of [2, 101, 102]) {
      expect(buildPaymentSchedule(f.estimate)?.rows.find(r => r.sequence === sequence)?.status).toBe(sequences.includes(sequence) ? 'PAID' : 'DUE');
    }
    expect(buildPaymentSchedule(f.estimate)?.rows.find(r => r.sequence === 3)?.status).toBe('UPCOMING');
  });

  it('requires City Fee acceptance only when that adjustment is selected', async () => {
    const f = await readyFixture();
    await expect(f.checkout([2, 101])).rejects.toThrow('accept the City Fee');
    await expect(f.checkout([101], false)).rejects.toThrow('accept the City Fee');
    expect(f.createSession).not.toHaveBeenCalled();
    await expect(f.checkout([2])).resolves.toHaveProperty('url');
  });

  it.each([[], [2, 2], [2, 3], [1], [999], [-1], [1.5]].map(sequences => ({ sequences })))('rejects invalid, paid or upcoming selection $sequences', async ({ sequences }) => {
    const f = await readyFixture();
    await expect(f.checkout(sequences, true)).rejects.toThrow();
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('rejects a refunded installment and conflicting selection formats', async () => {
    const f = await readyFixture();
    f.estimate.payments.push({ id: 88, idEst: 1, type: 'INSTALLMENT', sequence: 2, status: 'REFUNDED', baseAmount: decimal(954.02) });
    await expect(f.checkout([2])).rejects.toThrow('reconciliation');
    await expect(f.service.createCheckoutSessionForEstimate({ estimateId: 1, type: PaymentType.INSTALLMENT, sequence: 101,
      sequences: [2], user: f.actor, cityFeeAccepted: true })).rejects.toThrow('distinct installments');
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('resumes the same selection without creating a second Stripe session', async () => {
    const f = await readyFixture();
    const first = await f.checkout([2, 101], true);
    expect(await f.checkout([101, 2], true)).toEqual(first);
    expect(f.createSession).toHaveBeenCalledTimes(1);
    expect(f.expire).not.toHaveBeenCalled();
  });

  it('expires the previous combined session before opening checkout for release only', async () => {
    const f = await readyFixture();
    await f.checkout([2, 101], true);
    await f.checkout([2]);
    expect(f.expire).toHaveBeenCalledWith('cs_selection_1');
    expect(f.sessions.get('cs_selection_2').amount_total).toBe(95402);
    expect(f.estimate.payments.find(p => p.sequence === 101)).toMatchObject({ status: 'CANCELED', stripeSessionId: null });
    await f.confirm('cs_selection_2');
    expect(buildPaymentSchedule(f.estimate)?.rows.find(r => r.sequence === 101)?.balance).toBe('200.00');
  });

  it('closes both separate sessions before replacing them with one combined session', async () => {
    const f = await readyFixture();
    await f.checkout([2]); await f.checkout([101], true);
    await f.checkout([2, 101], true);
    expect(f.expire).toHaveBeenCalledTimes(2);
    expect(f.sessions.get('cs_selection_3').amount_total).toBe(115402);
    expect(f.estimate.payments.filter(p => p.stripeSessionId === 'cs_selection_3')).toHaveLength(2);
  });

  it('records an already completed session before a changed selection can cause another charge', async () => {
    const f = await readyFixture();
    await f.checkout([101], true);
    Object.assign(f.sessions.get('cs_selection_1'), { status: 'complete', payment_status: 'paid' });
    const result = await f.checkout([101, 2], true);
    expect(result.url).toContain('/orders/22');
    expect(f.createSession).toHaveBeenCalledTimes(1);
    expect(buildPaymentSchedule(f.estimate)?.rows.find(r => r.sequence === 101)?.status).toBe('PAID');
    expect(buildPaymentSchedule(f.estimate)?.rows.find(r => r.sequence === 2)?.status).toBe('DUE');
  });

  it('handles payment completion racing session expiration without reopening a paid charge', async () => {
    const f = await readyFixture();
    await f.checkout([2, 101], true);
    f.expire.mockImplementationOnce(async () => {
      Object.assign(f.sessions.get('cs_selection_1'), { status: 'complete', payment_status: 'paid' });
      throw new Error('Already completed');
    });
    await f.checkout([2]);
    expect(f.createSession).toHaveBeenCalledTimes(1);
    expect(buildPaymentSchedule(f.estimate)?.balance).toBe('238.51');
  });

  it('does not replace a session awaiting confirmation', async () => {
    const f = await readyFixture();
    await f.checkout([2, 101], true);
    f.sessions.get('cs_selection_1').status = 'complete';
    await expect(f.checkout([2])).rejects.toThrow('confirmation is pending');
    expect(f.createSession).toHaveBeenCalledTimes(1);
    expect(f.expire).not.toHaveBeenCalled();
  });

  it('cancels every allocation in a combined checkout without crediting either one', async () => {
    const f = await readyFixture();
    await f.checkout([2, 101], true);
    await f.service.cancelCheckoutSessionForEstimate({ estimateId: 1, type: PaymentType.INSTALLMENT, sequence: 101, user: f.actor,
      checkoutRef: f.sessions.get('cs_selection_1').metadata.checkoutRef });
    expect(f.estimate.payments.filter(p => p.status === 'CANCELED').map(p => p.sequence)).toEqual([2, 101]);
    expect(buildPaymentSchedule(f.estimate)?.paid).toBe('1192.53');
    expect(buildPaymentSchedule(f.estimate)?.rows.filter(r => r.status === 'DUE')).toHaveLength(2);
  });

  it('does not let a stale cancellation page close a newer checkout', async () => {
    const f = await readyFixture();
    await f.checkout([2, 101], true);
    const oldRef = f.sessions.get('cs_selection_1').metadata.checkoutRef;
    await f.checkout([2]);
    await f.service.cancelCheckoutSessionForEstimate({ estimateId: 1, type: PaymentType.INSTALLMENT, sequence: 2, user: f.actor, checkoutRef: oldRef });
    expect(f.sessions.get('cs_selection_2').status).toBe('open');
    expect(f.expire).toHaveBeenCalledTimes(1);
  });

  it('rejects an amount mismatch before crediting any part of the combined payment', async () => {
    const f = await readyFixture();
    await f.checkout([2, 101], true);
    f.sessions.get('cs_selection_1').amount_total = 115401;
    await expect(f.confirm('cs_selection_1')).rejects.toThrow('amount mismatch');
    expect(f.estimate.payments.filter(p => p.stripeSessionId === 'cs_selection_1').every(p => p.status === 'PENDING')).toBe(true);
  });

  it('rounds the combined card surcharge once and preserves the exact allocated cents', async () => {
    const f = await readyFixture();
    f.estimate.paymentPlanSnapshot.locked.rows.find(r => r.sequence === 2).amount = '0.17';
    f.estimate.paymentPlanSnapshot.adjustments[0].amount = '0.17';
    f.tx.globalParameter.findUnique.mockResolvedValue({ value: decimal(0.03) });
    await f.checkout([101, 2], true);
    const rows = f.estimate.payments.filter(p => p.stripeSessionId === 'cs_selection_1');
    expect(rows.map(p => p.surchargeAmount.toFixed(2))).toEqual(['0.01', '0.00']);
    expect(f.sessions.get('cs_selection_1').amount_total).toBe(35);
  });

  it('records the same selection as a verified manual payment without a card surcharge', async () => {
    const f = await readyFixture();
    await f.service.recordManualPayment({ estimateId: 1, type: PaymentType.INSTALLMENT, sequences: [101, 2], cityFeeAccepted: true,
      method: PaymentMethod.CHECK, fundsVerified: true, reference: 'CHECK-42', actor: { id: 1, role: { name: 'admin' } } });
    const rows = f.estimate.payments.filter(p => [2, 101].includes(p.sequence));
    expect(rows).toHaveLength(2);
    expect(rows.every(p => p.status === 'PAID' && p.manualReference === 'CHECK-42' && p.surchargeAmount.eq(0))).toBe(true);
    expect(buildPaymentSchedule(f.estimate)?.balance).toBe('238.51');
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('closes a combined card attempt before a verified manual payment for just one of its items', async () => {
    const f = await readyFixture();
    await f.checkout([2, 101], true);
    await f.manual(2);
    expect(f.expire).toHaveBeenCalledWith('cs_selection_1');
    expect(buildPaymentSchedule(f.estimate)?.rows.find(r => r.sequence === 2)?.status).toBe('PAID');
    expect(buildPaymentSchedule(f.estimate)?.rows.find(r => r.sequence === 101)?.status).toBe('DUE');
    expect(f.estimate.payments.find(p => p.sequence === 101)?.stripeSessionId).toBeNull();
  });

  it('expires all allocations of an abandoned session during reconciliation', async () => {
    const f = await readyFixture();
    await f.checkout([2, 101], true);
    f.sessions.get('cs_selection_1').status = 'expired';
    jest.spyOn(f.service as any, 'reconcilePaidPaymentEffects').mockResolvedValue(undefined);
    await f.service.reconcilePendingCheckoutSessions();
    expect(f.retrieve).toHaveBeenCalledTimes(1);
    expect(f.estimate.payments.filter(p => [2, 101].includes(p.sequence)).every(p => p.status === 'EXPIRED' && !p.stripeSessionId)).toBe(true);
    expect(buildPaymentSchedule(f.estimate)?.paid).toBe('1192.53');
  });

  it('supports the same selection through the internal dealer customer link', async () => {
    const f = await readyFixture(true);
    f.estimate.publicTokenEnabled = true; f.estimate.publicToken = 'customer-link';
    await f.service.createCheckoutSessionForPublicToken({ token: 'customer-link', sequences: [2], cityFeeAccepted: false });
    expect(f.sessions.get('cs_selection_1').amount_total).toBe(95402);
    await f.service.createCheckoutSessionForPublicToken({ token: 'customer-link', sequences: [101, 2], cityFeeAccepted: true });
    expect(f.sessions.get('cs_selection_2').amount_total).toBe(115402);
    const context = await f.service.getPublicPaymentContext('customer-link');
    expect(context.installmentCheckouts?.[0]).toMatchObject({ sequences: [2, 101], totalAmount: '1154.02' });
    await expect(f.service.createCheckoutSessionForPublicToken({ token: 'customer-link', sequences: [3] })).rejects.toThrow('not available');
  });
});

describe('Early full balance and operational milestones', () => {
  const fullManual = (f: ReturnType<typeof fixture>, expectedBalance: number) => f.service.recordManualPayment({
    estimateId: 1, type: PaymentType.INSTALLMENT, payFullBalance: true, expectedBalance,
    method: PaymentMethod.CHECK, fundsVerified: true, reference: 'FULL-42', actor: { id: 1, role: { name: 'admin' } },
  });

  it('credits the deposit once, pays all installments and preserves administrative order review', async () => {
    const f = fixture();
    await fullManual(f, 9750);
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ total: '10000.00', paid: '10000.00', balance: '0.00', fullBalance: null });
    expect(f.estimate.payments.filter(p => p.type === 'INSTALLMENT').map(p => p.baseAmount.toFixed(2))).toEqual(['4750.00', '4000.00', '1000.00']);
    expect(f.estimate.status.name).toBe('Pending order review');
    expect(f.estimate.order).toBeNull();
    await f.approve();
    expect(f.estimate.order.status.name).toBe('Pending');
    expect(f.estimate.installationJob.status).toBe('MATERIAL_PAID');
    f.estimate.order.status.name = 'Ready to pick up';
    await refreshScheduledInstallation(f.tx, 1);
    expect(f.estimate.installationJob.status).toBe('INSTALLATION_PAID');
    expect(f.estimate.installationJob.completedAt).toBeUndefined();
    expect(buildPaymentSchedule(f.estimate)?.next).toBeNull();
    await expect(fullManual(f, 9750)).rejects.toThrow('not available');
  });

  it('preserves the zero first confirmation when the deposit already covers the order installment', async () => {
    const f = fixture({ material: 200, installation: 200 });
    expect(buildPaymentSchedule(f.estimate)?.fullBalance).toEqual({ amount: '150.00', sequences: [1, 2, 3] });
    await fullManual(f, 150);
    expect(f.estimate.payments.filter(p => p.type === 'INSTALLMENT').map(p => p.baseAmount.toFixed(2))).toEqual(['0.00', '110.00', '40.00']);
    expect(f.estimate.status.name).toBe('Pending order review');
    expect(buildPaymentSchedule(f.estimate)?.paid).toBe('400.00');
  });

  it('recognizes an early release payment when a material-only order later becomes ready', async () => {
    const f = fixture({ deposit: 0, installation: 0 });
    await fullManual(f, 8000);
    expect(f.estimate.order.status.name).toBe('Pending');
    expect(buildPaymentSchedule(f.estimate)?.rows.every(row => row.status === 'PAID')).toBe(true);
    f.estimate.order.status.name = 'Ready to pick up';
    f.estimate.order.fulfillmentMethod = 'CUSTOMER_PICKUP';
    f.tx.order.update = jest.fn(async () => ({ status: { name: 'Picked up' } }));
    const deliveries = new DeliveriesService(f.tx, {} as never, {} as never,
      { createAndSend: jest.fn() } as never, { log: jest.fn() } as never, {} as never);
    await deliveries.completePickup(22, { id: 1, role: { name: 'admin' } });
    expect(f.tx.order.update).toHaveBeenCalledTimes(1);
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('excludes an unknown City Fee and adds it once later without changing prepaid installments', async () => {
    const f = fixture({ material: 1313.10 });
    f.estimate.installationJob.permit = { status: 'SUBMITTED', permitFeeSnapshot: decimal(1500), cityFee: null };
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ cityFeePending: true, fullBalance: { amount: '4563.10' } });
    await fullManual(f, 4563.10);
    const locked = structuredClone(f.estimate.paymentPlanSnapshot.locked.rows);
    f.estimate.installationJob.permit.status = 'APPROVED';
    f.estimate.installationJob.permit.cityFee = decimal(200);
    await synchronizeScheduleChanges(f.tx, 1); await synchronizeScheduleChanges(f.tx, 1);
    expect(f.estimate.paymentPlanSnapshot.locked.rows).toEqual(locked);
    expect(f.estimate.paymentPlanSnapshot.adjustments).toHaveLength(1);
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ cityFeePending: false, paid: '4813.10', balance: '200.00',
      next: { kind: 'CITY_FEE', balance: '200.00' }, fullBalance: { amount: '200.00', sequences: [101] } });
  });

  it.each(['DEPOSIT_PAYMENT_PENDING', 'CUSTOMER_APPROVAL_PENDING'])('does not offer full balance before prerequisites: %s', async status => {
    const f = fixture({ deposit: 0 });
    f.estimate.installationJob.status = status;
    if (status === 'CUSTOMER_APPROVAL_PENDING') f.estimate.installationJob.quotes[0].status = status;
    expect(buildPaymentSchedule(f.estimate)?.fullBalance).toBeNull();
    await expect(fullManual(f, 10000)).rejects.toThrow('not available');
  });

  it('still requires the client to accept material details before a full initial card payment', async () => {
    const f = fixture({ role: 'client' });
    Object.assign(f.estimate.user, { street: '123 Example Street', city: 'Miami', state: 'FL', postalCode: '33101' });
    await expect(f.service.createCheckoutSessionForEstimate({ estimateId: 1, type: PaymentType.INSTALLMENT,
      payFullBalance: true, expectedBalance: 9750, user: f.actor })).rejects.toThrow('accept the material details');
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it('prepays an explicit before-installation milestone while manufacturing remains pending', async () => {
    const f = fixture();
    f.estimate.paymentPlanSnapshot.definition = { ...plan, withInstallation: [
      { milestone: 'ORDER', basis: 'PROJECT', percent: 50 },
      { milestone: 'RELEASE', basis: 'PROJECT', percent: 20 },
      { milestone: 'INSTALL', basis: 'PROJECT', percent: 20 },
      { milestone: 'COMPLETE', basis: 'PROJECT', percent: 10 },
    ] };
    await f.manual(1); await f.approve();
    expect(buildPaymentSchedule(f.estimate)?.next).toBeNull();
    expect(buildPaymentSchedule(f.estimate)?.fullBalance).toEqual({ amount: '5000.00', sequences: [2, 3, 4] });
    await fullManual(f, 5000);
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ balance: '0.00', canInstall: true });
    expect(f.estimate.order.status.name).toBe('Pending');
    expect(f.estimate.installationJob.status).toBe('MATERIAL_PAID');
    f.estimate.order.status.name = 'Ready to pick up';
    await refreshScheduledInstallation(f.tx, 1);
    expect(f.estimate.installationJob.status).toBe('INSTALLATION_PAID');
  });
});

// Regresiones de devoluciones con los servicios de pago y calendario reales.
describe('Refund review and payment recovery', () => {
  const admin: any = { id: 1, role: { name: 'admin' } };
  async function captured() {
    const f = fixture({ deposit: 0, installation: 0, role: 'client', mode: '' });
    await f.service.createCheckoutSessionForEstimate({ estimateId: 1, type: PaymentType.INSTALLMENT, sequence: 1, materialAccepted: true, user: f.actor });
    const session: any = { id: 'cs_simulated', payment_intent: 'pi_cs_simulated', payment_status: 'paid', amount_total: 412000, currency: 'usd' };
    await (f.service as any).processPaidCheckoutSession(f.tx, session);
    const charge = (await f.stripe.paymentIntents.retrieve('pi_cs_simulated') as any).latest_charge;
    const refund: any = { id: 're_1', object: 'refund', charge: charge.id, amount: 10000, currency: 'usd', status: 'succeeded', created: 1700000100 };
    const review = (credit = 0, actor = admin) => f.service.reviewRefund(1, 're_1', {
      note: 'Reviewed project balance', allocations: f.ledger.allocations.filter(a => a.refundId === 're_1').map(a => ({ id: a.id, creditAmount: credit })),
    }, actor);
    return { ...f, session, charge, refund, review };
  }

  it('deducts only confirmed principal and pauses the affected payment until reviewed', async () => {
    const f = await captured();
    await reconcileChargeRefunds(f.tx, f.charge, [f.refund]);
    const schedule = buildPaymentSchedule(f.estimate)!;
    expect(schedule).toMatchObject({ paid: '3902.91', balance: '4097.09', refundReviewPending: true, fullBalance: null });
    expect(schedule.rows[0]).toMatchObject({ status: 'REVIEW', balance: '97.09' });
    expect(f.ledger.receipts[0].amount.toFixed(2)).toBe('4120.00');
    await expect(f.manual(1)).rejects.toThrow('not available');
    expect(f.estimate.order.status.name).toBe('Pending');
  });

  it('allows a verified manual repayment after review without losing the original Stripe receipt', async () => {
    const f = await captured();
    await reconcileChargeRefunds(f.tx, f.charge, [f.refund]);
    await f.review();
    expect(buildPaymentSchedule(f.estimate)!.next).toMatchObject({ sequence: 1, balance: '97.09', status: 'DUE' });
    expect(f.estimate.payments[0].stripeSessionId).toBeNull();
    await f.manual(1);
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ paid: '4000.00', balance: '4000.00' });
    expect(f.ledger.receipts).toHaveLength(2);
    expect(f.ledger.receipts.map(r => r.paymentMethod)).toEqual(['CARD', 'CASH']);
    expect(f.tx.order.create).toHaveBeenCalledTimes(1);
    await expect(f.manual(1)).rejects.toThrow();
  });

  it('can collect the reviewed balance through Stripe and ignores repeated old refund events', async () => {
    const f = await captured();
    await reconcileChargeRefunds(f.tx, f.charge, [f.refund]); await f.review();
    f.createSession.mockResolvedValue({ id: 'cs_recovery', url: 'https://checkout.stripe.com/recovery' } as any);
    await f.service.createCheckoutSessionForEstimate({ estimateId: 1, type: PaymentType.INSTALLMENT, sequence: 1, materialAccepted: true, user: f.actor });
    await (f.service as any).processPaidCheckoutSession(f.tx, { id: 'cs_recovery', payment_intent: 'pi_cs_recovery', payment_status: 'paid', currency: 'usd', amount_total: 10000 });
    await reconcileChargeRefunds(f.tx, f.charge, [f.refund]);
    expect(f.ledger.receipts).toHaveLength(2);
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ paid: '4000.00', balance: '4000.00', refundReviewPending: false });
    expect(f.ledger.refunds).toHaveLength(1);
  });

  it('reduces the amount owed when administration approves a new price reduction', async () => {
    const f = await captured();
    await reconcileChargeRefunds(f.tx, f.charge, [f.refund]); await f.review(97.09);
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ total: '7902.91', paid: '3902.91', balance: '4000.00', refundReviewPending: false });
    expect(buildPaymentSchedule(f.estimate)!.rows[0]).toMatchObject({ status: 'PAID', amount: '3902.91', balance: '0.00' });
    await f.review(97.09); // Reintento idempotente.
    await expect(f.review(0)).rejects.toThrow('already been reviewed');
  });

  it('does not count a pending or failed refund as money already returned', async () => {
    const f = await captured();
    await reconcileChargeRefunds(f.tx, f.charge, [{ ...f.refund, status: 'pending' }]);
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ paid: '4000.00', refundReviewPending: true });
    await reconcileChargeRefunds(f.tx, f.charge, [{ ...f.refund, status: 'failed', failure_reason: 'lost_or_stolen_card' }]);
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ paid: '4000.00', balance: '4000.00', refundReviewPending: false });
    await expect(f.review()).rejects.toThrow('failed');
  });

  it('preserves the commercial credit if an approved pending refund later fails', async () => {
    const f = await captured();
    await reconcileChargeRefunds(f.tx, f.charge, [{ ...f.refund, status: 'pending' }]); await f.review(97.09);
    await reconcileChargeRefunds(f.tx, f.charge, [{ ...f.refund, status: 'failed' }]);
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ total: '7902.91', paid: '4000.00', balance: '3902.91' });
  });

  it('handles multiple partial refunds and a final full refund without duplicate deductions', async () => {
    const f = await captured();
    const remainder: any = { ...f.refund, id: 're_2', amount: 402000, created: 1700000200 };
    await reconcileChargeRefunds(f.tx, f.charge, [remainder, f.refund]);
    await reconcileChargeRefunds(f.tx, f.charge, [f.refund, remainder]);
    expect(f.ledger.allocations).toHaveLength(2);
    expect(f.estimate.payments[0]).toMatchObject({ status: 'REFUNDED', refundReviewPending: true });
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ paid: '0.00', balance: '8000.00', refunded: '4120.00' });
    expect(f.estimate.order).not.toBeNull();
  });

  it.each(['dealer', 'client'])('denies refund review to %s, even the owner', async role => {
    const f = await captured(); await reconcileChargeRefunds(f.tx, f.charge, [f.refund]);
    await expect(f.review(0, { id: 7, role: { name: role } })).rejects.toThrow('Only administrators');
  });

  it('denies history for other owners and hides administrative notes from the customer', async () => {
    const f = await captured(); await reconcileChargeRefunds(f.tx, f.charge, [f.refund]); await f.review();
    // History API queries include receipts; model that read without bypassing ownership checks.
    const findMany = f.tx.payment.findMany;
    f.tx.payment.findMany = jest.fn(async args => (await findMany(args)).map(p => ({ ...p, receipts: f.ledger.receipts.filter(r => r.paymentId === p.id).map(r => ({ ...r,
      allocations: f.ledger.allocations.filter(a => a.receiptId === r.id).map(a => ({ ...a, refund: f.ledger.refunds.find(x => x.id === a.refundId) })) })) })));
    await expect(f.service.getPaymentHistory(1, { id: 123, role: { name: 'client' } })).rejects.toThrow('not found');
    const history = await f.service.getPaymentHistory(1, f.actor);
    expect(history.canReview).toBe(false); expect(history.refunds[0].note).toBeUndefined();
    expect(history.receipts[0]).toMatchObject({ amount: '4120.00', method: 'Card', refunded: '100.00' });
  });

  it('validates allocation amounts, complete selection and an active checkout before review', async () => {
    const f = await captured(); await reconcileChargeRefunds(f.tx, f.charge, [f.refund]);
    await expect(f.review(100)).rejects.toThrow('refunded principal');
    await expect(f.service.reviewRefund(1, 're_1', { note: 'Review', allocations: [] }, admin)).rejects.toThrow('every refund allocation');
    f.estimate.payments.push({ idEst: 1, status: 'PENDING', stripeSessionId: 'cs_open' });
    await expect(f.review()).rejects.toThrow('active checkout');
  });
  it('returns only a duplicate overpayment without manufacturing another debt', async () => {
    const f = await captured();
    const payment = f.estimate.payments[0];
    const duplicateCharge: any = { ...f.charge, id: 'ch_duplicate', payment_intent: 'pi_duplicate', amount_captured: 10300 };
    await recordStripeReceipt(f.tx, { ...payment, amount: decimal(103), baseAmount: decimal(100), surchargeAmount: decimal(3) }, duplicateCharge, 'cs_duplicate');
    await refreshPaymentAccounting(f.tx, payment.id);
    expect(buildPaymentSchedule(f.estimate)!.paid).toBe('4100.00');
    await reconcileChargeRefunds(f.tx, duplicateCharge, [{ ...f.refund, charge: 'ch_duplicate', amount: 10300, reason: 'duplicate' }]);
    await f.review();
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ paid: '4000.00', balance: '4000.00' });
    expect(buildPaymentSchedule(f.estimate)!.rows[0].balance).toBe('0.00');
    expect(f.ledger.receipts).toHaveLength(2);
  });

  it('does not reverse an installed order or a completed installation after refund', async () => {
    const f = await captured();
    f.estimate.order.status.name = 'Installed';
    f.estimate.installationJob = { id: 3, status: 'COMPLETED', completedAt: new Date(), quotes: [{ status: 'APPROVED', total: decimal(0) }], appointments: [] };
    await reconcileChargeRefunds(f.tx, f.charge, [f.refund]); await f.review();
    expect(f.estimate.order.status.name).toBe('Installed');
    expect(f.estimate.installationJob.status).toBe('COMPLETED');
  });

  it('uses current Stripe refund state when an older webhook arrives later', async () => {
    const f = await captured();
    const event: any = { type: 'refund.created', data: { object: { ...f.refund, status: 'pending' } } };
    jest.spyOn(f.stripe.webhooks, 'constructEvent').mockReturnValue(event);
    jest.spyOn(f.stripe.charges, 'retrieve').mockResolvedValue(f.charge);
    f.refunds.mockResolvedValue({ data: [f.refund], has_more: false } as any);
    await f.service.handleStripeWebhook(Buffer.from('simulated'), 'signed-test');
    await f.service.handleStripeWebhook(Buffer.from('simulated'), 'signed-test');
    expect(f.ledger.refunds[0].status).toBe('succeeded');
    expect(f.ledger.allocations).toHaveLength(1);
    expect(buildPaymentSchedule(f.estimate)!.paid).toBe('3902.91');
  });

  it('keeps an asynchronous bank payment pending until confirmed and records Bank (Link)', async () => {
    const f = fixture({ deposit: 0, installation: 0, role: 'client', mode: '' });
    await f.service.createCheckoutSessionForEstimate({ estimateId: 1, type: PaymentType.INSTALLMENT, sequence: 1, materialAccepted: true, user: f.actor });
    const session: any = { id: 'cs_simulated', payment_intent: 'pi_cs_simulated', status: 'complete', payment_status: 'unpaid', amount_total: 412000, currency: 'usd' };
    const events = jest.spyOn(f.stripe.webhooks, 'constructEvent').mockReturnValue({ type: 'checkout.session.completed', data: { object: session } } as any);
    await f.service.handleStripeWebhook(Buffer.from('simulated'), 'signed-test');
    expect(f.estimate.payments[0].status).toBe('PENDING'); expect(f.ledger.receipts).toHaveLength(0);
    expect(f.estimate.order).toBeNull();
    f.intent.mockResolvedValue({ id: 'pi_cs_simulated', status: 'succeeded', latest_charge: { id: 'ch_bank', payment_intent: 'pi_cs_simulated',
      amount_captured: 412000, currency: 'usd', created: 1700000000, paid: true, captured: true,
      payment_method_details: { type: 'card', card: { brand: 'link', wallet: { type: 'link', link: { funding_source_group: 'lfsg_003' } } } } } } as any);
    session.payment_status = 'paid';
    events.mockReturnValue({ type: 'checkout.session.async_payment_succeeded', data: { object: session } } as any);
    await f.service.handleStripeWebhook(Buffer.from('simulated'), 'signed-test');
    expect(f.estimate.payments[0]).toMatchObject({ status: 'PAID', paymentMethod: 'BANK', paymentMethodLabel: 'Bank (Link)' });
    expect(f.ledger.receipts).toHaveLength(1); expect(f.ledger.receipts[0].paymentMethod).toBe('BANK');
    // Un evento de fallo antiguo no puede deshacer una confirmación posterior.
    jest.spyOn(f.stripe.checkout.sessions, 'retrieve').mockResolvedValue(session);
    events.mockReturnValue({ type: 'checkout.session.async_payment_failed', data: { object: { ...session, payment_status: 'unpaid' } } } as any);
    await f.service.handleStripeWebhook(Buffer.from('simulated'), 'signed-test');
    expect(f.estimate.payments[0].status).toBe('PAID'); expect(f.tx.order.create).toHaveBeenCalledTimes(1);
  });

  it('marks a failed bank checkout as failed without crediting funds or creating an order', async () => {
    const f = fixture({ deposit: 0, installation: 0 });
    await f.service.createCheckoutSessionForEstimate({ estimateId: 1, type: PaymentType.INSTALLMENT, sequence: 1, user: f.actor });
    const session: any = { id: 'cs_simulated', payment_status: 'unpaid', status: 'complete' };
    jest.spyOn(f.stripe.checkout.sessions, 'retrieve').mockResolvedValue(session);
    jest.spyOn(f.stripe.webhooks, 'constructEvent').mockReturnValue({ type: 'checkout.session.async_payment_failed', data: { object: session } } as any);
    await f.service.handleStripeWebhook(Buffer.from('simulated'), 'signed-test');
    expect(f.estimate.payments[0]).toMatchObject({ status: 'FAILED', stripeSessionId: null });
    expect(f.ledger.receipts).toHaveLength(0); expect(f.estimate.order).toBeNull();
  });

});
