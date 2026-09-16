import {
  allocateSchedule,
  defaultPlan,
  planRows,
  PlanDefinition,
  PlanSnapshot,
  validatePlan,
} from './payment-plan';
import {
  assertScheduleMilestone,
  buildPaymentSchedule,
  installmentContext,
  resolveNewPlan,
  synchronizeScheduleChanges,
} from './payment-schedule';

const project: PlanDefinition = {
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
const split: PlanDefinition = {
  ...project,
  withInstallation: [
    ...project.withoutInstallation,
    { milestone: 'INSTALL', basis: 'INSTALLATION', percent: 50 },
    { milestone: 'COMPLETE', basis: 'INSTALLATION', percent: 50 },
  ],
};
const snapshot = (definition = project): PlanSnapshot => ({
  version: 1,
  planId: 2,
  name: 'Project plan',
  definition,
});
const amounts = {
  material: '8000.00',
  installation: '2000.00',
  permit: '0.00',
  city: '0.00',
};
const paid = (type: string, baseAmount: string, sequence = 1) => ({
  type,
  baseAmount,
  sequence,
  status: 'PAID',
});
function estimate(definition = project): any {
  return {
    id: 1,
    idUser: 8,
    number: '190999',
    units: 2,
    totalPayable: '8000.00',
    priceT: '8000.00',
    taxAmount: '0.00',
    taxRate: 0,
    customerTotalPayable: '9000.00',
    paymentPlanSnapshot: snapshot(definition),
    status: { name: 'Active' },
    payments: [],
    order: null,
    installationJob: {
      status: 'MATERIAL_PAYMENT_PENDING',
      quotes: [{ status: 'APPROVED', total: '2000.00' }],
      permit: null,
      appointments: [],
    },
  };
}

describe('Configurable payment plans', () => {
  it('does not create a negative final installment from rounding tiny amounts', () => {
    const definition: PlanDefinition = {
      ...project,
      withInstallation: ['ORDER', 'RELEASE', 'INSTALL', 'COMPLETE'].map(
        (milestone) => ({
          milestone: milestone as any,
          basis: 'PROJECT',
          percent: 25,
        }),
      ),
    };
    const rows = planRows(
      snapshot(definition),
      { material: '0.02', installation: '0.00', permit: '0.00', city: '0.00' },
      true,
    );
    expect(rows.map((row) => row.amount)).toEqual([
      '0.01',
      '0.01',
      '0.00',
      '0.00',
    ]);
  });
  it('recalculates the whole unpaid order installment after canceling checkout and changing its estimate', async () => {
    const est = estimate();
    est.paymentPlanSnapshot.locked = {
      amounts,
      rows: planRows(snapshot(), amounts, true),
      at: '2026-09-15',
    };
    est.payments = [
      paid('INSTALLATION_DEPOSIT', '250.00'),
      {
        ...paid('INSTALLMENT', '4750.00'),
        status: 'CANCELED',
        stripeSessionId: null,
      },
    ];
    est.installationJob.quotes[0].total = '3000.00';
    const db: any = {
      estimate: {
        findUnique: jest.fn(async () => est),
        update: jest.fn(async ({ data }) => Object.assign(est, data)),
      },
    };
    await synchronizeScheduleChanges(db, est.id);
    expect(est.paymentPlanSnapshot.locked).toBeUndefined();
    expect(est.paymentPlanSnapshot.adjustments).toBeUndefined();
    expect(buildPaymentSchedule(est)?.next?.balance).toBe('5250.00');
    expect(buildPaymentSchedule(est)?.total).toBe('11000.00');
  });
  it.each([project, split, defaultPlan])('validates a complete plan', (plan) =>
    expect(validatePlan(plan)).toEqual(plan),
  );
  it.each([
    {
      ...project,
      withoutInstallation: [
        { milestone: 'COMPLETE', basis: 'MATERIAL', percent: 100 },
      ],
    },
    {
      ...project,
      withInstallation: [{ milestone: 'ORDER', basis: 'PROJECT', percent: 99 }],
    },
    {
      ...project,
      withInstallation: [
        { milestone: 'ORDER', basis: 'PROJECT', percent: 100 },
        { milestone: 'RELEASE', basis: 'MATERIAL', percent: 100 },
      ],
    },
    {
      ...project,
      withInstallation: [
        { milestone: 'ORDER', basis: 'MATERIAL', percent: 100 },
      ],
    },
    {
      ...project,
      withoutInstallation: [
        { milestone: 'RELEASE', basis: 'MATERIAL', percent: 100 },
      ],
    },
    {
      ...project,
      withoutInstallation: [
        { milestone: 'ORDER', basis: 'MATERIAL', percent: -1 },
        { milestone: 'RELEASE', basis: 'MATERIAL', percent: 101 },
      ],
    },
  ])('rejects incomplete or contradictory plans', (plan) =>
    expect(() => validatePlan(plan)).toThrow(),
  );

  it('deducts the deposit from the initial project percentage, not from the price or the final installation payment', () => {
    const rows = planRows(snapshot(), amounts, true);
    const result = allocateSchedule(
      rows,
      [paid('INSTALLATION_DEPOSIT', '250.00')],
      ['ORDER'],
      false,
    );
    expect(result.rows.map((row) => row.amount)).toEqual([
      '5000.00',
      '4000.00',
      '1000.00',
    ]);
    expect(result.next?.balance).toBe('4750.00');
    expect(result.total).toBe('10000.00');
    expect(result.balance).toBe('9750.00');
    const after = allocateSchedule(
      rows,
      [paid('INSTALLATION_DEPOSIT', '250.00'), paid('INSTALLMENT', '4750.00')],
      ['ORDER', 'RELEASE'],
      true,
    );
    expect(after.next?.balance).toBe('4000.00');
    expect(after.rows[2].balance).toBe('1000.00');
  });

  it('credits the material installment in a separate plan and leaves the full installation split intact', () => {
    const rows = planRows(snapshot(split), amounts, true);
    const result = allocateSchedule(
      rows,
      [paid('INSTALLATION_DEPOSIT', '250.00')],
      ['ORDER'],
      false,
    );
    expect(result.rows.map((row) => row.balance)).toEqual([
      '3750.00',
      '4000.00',
      '1000.00',
      '1000.00',
    ]);
  });

  it('carries a deposit exceeding the first installment and still requires confirmation to place the order', () => {
    const rows = planRows(
      snapshot(),
      { ...amounts, material: '300.00', installation: '100.00' },
      true,
    );
    const result = allocateSchedule(
      rows,
      [paid('INSTALLATION_DEPOSIT', '250.00')],
      ['ORDER'],
      false,
    );
    expect(result.next?.sequence).toBe(1);
    expect(result.next?.balance).toBe('0.00');
    expect(result.rows[1].balance).toBe('110.00');
    expect(result.rows[2].balance).toBe('40.00');
    const after = allocateSchedule(
      rows,
      [paid('INSTALLATION_DEPOSIT', '250.00'), paid('INSTALLMENT', '0.00')],
      ['ORDER', 'RELEASE'],
      true,
    );
    expect(after.next?.sequence).toBe(2);
    expect(after.paid).toBe('250.00');
  });

  it('does not credit pending, refunded, delivery, extra-charge or card fee amounts', () => {
    const rows = planRows(snapshot(), amounts, true);
    const result = allocateSchedule(
      rows,
      [
        {
          ...paid('INSTALLATION_DEPOSIT', '250.00'),
          amount: '260.00',
          surchargeAmount: '10.00',
        } as any,
        { ...paid('INSTALLMENT', '1000.00'), status: 'PENDING' },
        { ...paid('INSTALLMENT', '500.00'), status: 'REFUNDED' },
        paid('DELIVERY', '100.00'),
        paid('EXTRA', '80.00'),
      ],
      ['ORDER'],
      false,
    );
    expect(result.paid).toBe('250.00');
    expect(result.next?.balance).toBe('4750.00');
  });

  it('allocates rounding cents to the final installment without losing a cent', () => {
    const plan: PlanDefinition = {
      ...project,
      withoutInstallation: [
        { milestone: 'ORDER', basis: 'MATERIAL', percent: 33.33 },
        { milestone: 'RELEASE', basis: 'MATERIAL', percent: 66.67 },
      ],
    };
    expect(
      planRows(
        snapshot(plan),
        { ...amounts, material: '10.01', installation: '0.00' },
        false,
      ).map((row) => row.amount),
    ).toEqual(['3.34', '6.67']);
  });

  it.each([project, split])(
    'credits an earlier permit payment exactly once',
    (plan) => {
      const rows = planRows(
        snapshot(plan),
        { ...amounts, permit: '1000.00', city: '200.00' },
        true,
      );
      const result = allocateSchedule(
        rows,
        [paid('PERMIT', '1000.00'), paid('INSTALLATION_DEPOSIT', '250.00')],
        ['ORDER'],
        false,
      );
      expect(result.total).toBe('11200.00');
      expect(result.balance).toBe('9950.00');
      expect(result.paid).toBe('1250.00');
      expect(result.next?.balance).toBe(
        plan === project ? '4350.00' : '3950.00',
      );
    },
  );

  it('uses company prices for external dealers and customer prices for internal dealers', () => {
    const external = { ...estimate(), dealerModeSnapshot: 'EXTERNAL' };
    const internal = { ...estimate(), dealerModeSnapshot: 'INTERNAL' };
    expect(buildPaymentSchedule(external)?.total).toBe('10000.00');
    expect(buildPaymentSchedule(internal)?.total).toBe('11000.00');
  });

  it('opens the release installment at Ready to pick up, blocks release until paid, and does not invent installation', async () => {
    const est = {
      ...estimate(),
      installationJob: null,
      order: { id: 4, status: { name: 'In production' } },
      payments: [paid('INSTALLMENT', '4000.00')],
      status: { name: 'Ordered' },
    };
    expect(buildPaymentSchedule(est)?.next).toBeNull();
    est.order.status.name = 'Ready to pick up';
    expect(buildPaymentSchedule(est)?.next?.sequence).toBe(2);
    expect(buildPaymentSchedule(est)?.canRelease).toBe(false);
    const db: any = { estimate: { findUnique: jest.fn(async () => est) } };
    await expect(
      assertScheduleMilestone(db, est.id, 'RELEASE'),
    ).rejects.toThrow('release');
    est.payments.push(paid('INSTALLMENT', '4000.00', 2));
    expect(buildPaymentSchedule(est)?.canRelease).toBe(true);
    expect(buildPaymentSchedule(est)?.rows).toHaveLength(2);
  });

  it('allows installation after 90% and opens the last 10% only after completion', () => {
    const est = estimate();
    est.order = { id: 4, status: { name: 'Ready to pick up' } };
    est.payments = [
      paid('INSTALLMENT', '5000.00'),
      paid('INSTALLMENT', '4000.00', 2),
    ];
    expect(buildPaymentSchedule(est)?.canInstall).toBe(true);
    expect(buildPaymentSchedule(est)?.next).toBeNull();
    est.order.status.name = 'Installed';
    est.installationJob.status = 'COMPLETED';
    expect(buildPaymentSchedule(est)?.next?.balance).toBe('1000.00');
  });

  it('separates the release payment from the pre-installation payment in a split plan', () => {
    const est = estimate(split);
    est.order = { id: 4, status: { name: 'Ready to pick up' } };
    est.payments = [
      paid('INSTALLATION_DEPOSIT', '250.00'),
      paid('INSTALLMENT', '3750.00'),
      paid('INSTALLMENT', '4000.00', 2),
    ];
    expect(buildPaymentSchedule(est)?.canRelease).toBe(true);
    expect(buildPaymentSchedule(est)?.canInstall).toBe(false);
    expect(buildPaymentSchedule(est)?.next?.balance).toBe('1000.00');
    est.payments.push(paid('INSTALLMENT', '1000.00', 3));
    expect(buildPaymentSchedule(est)?.canInstall).toBe(true);
    expect(buildPaymentSchedule(est)?.balance).toBe('1000.00');
  });

  it('freezes the original installments and adds approved changes separately', async () => {
    const est = estimate();
    const originalRows = planRows(snapshot(), amounts, true);
    est.paymentPlanSnapshot.locked = {
      amounts,
      rows: originalRows,
      at: new Date().toISOString(),
    };
    est.order = { id: 4, status: { name: 'In production' } };
    est.payments = [paid('INSTALLMENT', '5000.00')];
    est.installationJob.quotes[0].total = '3000.00';
    const db: any = {
      estimate: {
        findUnique: jest.fn(async () => est),
        update: jest.fn(async ({ data }) => Object.assign(est, data)),
      },
    };
    await synchronizeScheduleChanges(db, est.id);
    expect(est.paymentPlanSnapshot.locked.rows).toEqual(originalRows);
    expect(est.paymentPlanSnapshot.adjustments[0]).toMatchObject({
      sequence: 101,
      amount: '1000.00',
      milestone: 'RELEASE',
    });
    await synchronizeScheduleChanges(db, est.id);
    expect(est.paymentPlanSnapshot.adjustments).toHaveLength(1);
    expect(buildPaymentSchedule(est)?.balance).toBe('6000.00');
  });

  it('keeps unpaid changes out of the schedule until approved and blocks changes during checkout', async () => {
    const est = estimate();
    est.paymentPlanSnapshot.locked = {
      amounts,
      rows: planRows(snapshot(), amounts, true),
      at: '2026-09-15',
    };
    est.installationJob.quotes[0] = { status: 'DRAFT', total: '3000.00' };
    const db: any = {
      estimate: { findUnique: jest.fn(async () => est), update: jest.fn() },
    };
    await synchronizeScheduleChanges(db, est.id);
    expect(db.estimate.update).not.toHaveBeenCalled();
    est.installationJob.quotes[0].status = 'APPROVED';
    est.payments = [
      {
        ...paid('INSTALLMENT', '5000.00'),
        status: 'PENDING',
        stripeSessionId: 'cs_test',
      },
    ];
    await expect(synchronizeScheduleChanges(db, est.id)).rejects.toThrow(
      'Cancel',
    );
  });

  it('treats approved reductions as credits without overwriting any payment', () => {
    const rows = planRows(snapshot(), amounts, true);
    const result = allocateSchedule(
      [
        ...rows,
        {
          sequence: 101,
          milestone: 'RELEASE',
          title: 'Adjustment',
          description: '',
          amount: '-700.00',
        },
      ],
      [paid('INSTALLMENT', '5000.00')],
      ['ORDER', 'RELEASE'],
      true,
    );
    expect(result.next?.balance).toBe('3300.00');
    expect(result.paid).toBe('5000.00');
    expect(result.total).toBe('9300.00');
  });

  it('enforces sequence on the server and freezes amounts only at checkout', async () => {
    const est = estimate();
    const db: any = {
      estimate: {
        findUniqueOrThrow: jest.fn(async () => est),
        update: jest.fn(),
      },
    };
    await expect(installmentContext(db, 1, 2)).rejects.toThrow('next');
    await installmentContext(db, 1, 1, true);
    expect(db.estimate.update).not.toHaveBeenCalled();
    await installmentContext(db, 1, 1);
    expect(db.estimate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          paymentPlanSnapshot: expect.objectContaining({
            locked: expect.any(Object),
          }),
        },
      }),
    );
  });

  it('uses the user override first, then the role, and preserves a copied definition', async () => {
    const user = { paymentPlanId: 3, role: { paymentPlanId: 2 } };
    const db: any = {
      user: { findUniqueOrThrow: jest.fn(async () => user) },
      paymentPlan: {
        findUnique: jest.fn(async ({ where }) => ({
          id: where.id,
          name: 'Assigned',
          definition: project,
        })),
      },
    };
    const selected = await resolveNewPlan(db, 8);
    expect(selected.planId).toBe(3);
    user.paymentPlanId = null as any;
    expect((await resolveNewPlan(db, 8)).planId).toBe(2);
    expect(selected.definition).not.toBe(project);
  });
  it('leaves historical estimates on their existing payment rules', () =>
    expect(
      buildPaymentSchedule({ ...estimate(), paymentPlanSnapshot: null }),
    ).toBeNull());
});
