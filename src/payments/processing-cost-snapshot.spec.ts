import Decimal from 'decimal.js';
import { defaultPlan, planRows, type PlanDefinition, type PlanSnapshot, type ScheduleAmounts } from '@/payment-plans/payment-plan';
import { advanceProcessingComponents, freezeProcessingCostSnapshot, installmentProcessingComponents, pendingProcessingComponents, refundedProcessingComponents, singleProcessingComponent } from './processing-cost-snapshot';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';

const amounts: ScheduleAmounts = { material: '100.00', installation: '60.00', permit: '20.00', city: '20.00' };
const project: PlanDefinition = {
  withInstallation: [{ milestone: 'ORDER', basis: 'PROJECT', percent: 50 }, { milestone: 'RELEASE', basis: 'PROJECT', percent: 50 }],
  withoutInstallation: defaultPlan.withoutInstallation,
};
function snapshot(definition = project, values = amounts): PlanSnapshot {
  const value: PlanSnapshot = { version: 1, planId: 1, name: 'Saved', definition };
  value.locked = { amounts: { ...values }, rows: planRows(value, values, true), at: '2026-01-01T00:00:00.000Z' };
  return value;
}
function components(value: PlanSnapshot, sequence = 1, balance?: string) {
  const saved = value.locked!.rows.find(row => row.sequence === sequence) ?? value.adjustments!.find(row => row.sequence === sequence)!;
  return installmentProcessingComponents({ snapshot: value, amounts: { ...amounts, material: '9999.00' }, withInstallation: true,
    row: { ...saved, originalAmount: saved.amount, balance: balance ?? saved.amount } });
}
function freeze(base: string, fee: string, value: ReturnType<typeof singleProcessingComponent>) {
  return freezeProcessingCostSnapshot({ baseAmount: new Decimal(base), surchargeAmount: new Decimal(fee),
    totalAmount: new Decimal(base).plus(fee), processingComponents: value }) as any;
}

describe('Frozen processing-cost allocation', () => {
  it('keeps material tax in its base and City Fee separate, including proportional surcharge', () => {
    const base = { ...singleProcessingComponent('material', '100'), city: '20.00' };
    expect(freeze('120', '3.60', base)).toEqual({ version: 1,
      components: { material: '103.00', installation: '0.00', permit: '0.00', city: '20.60', other: '0.00' },
      total: '123.60', materialSurcharge: '3.00' });
  });

  it('allocates a one-cent surcharge deterministically without losing or adding cents', () => {
    const base = { ...singleProcessingComponent('material', '0.01'), installation: '0.01' };
    expect(freeze('0.02', '0.01', base)).toMatchObject({ components: { material: '0.02', installation: '0.01' }, total: '0.03', materialSurcharge: '0.01' });
  });

  it.each(['installation', 'permit', 'city', 'other'] as const)('keeps %s fees outside material', key => {
    const value = freeze('10', '0.30', singleProcessingComponent(key, '10'));
    expect(value.components[key]).toBe('10.30');
    expect(value.components.material).toBe('0.00'); expect(value.materialSurcharge).toBe('0.00');
    expect(value).not.toHaveProperty('allocationPending');
  });

  it('never reads mutable estimate amounts when freezing a checkout or retry', () => {
    const input = { baseAmount: '100', surchargeAmount: '3', totalAmount: '103', processingComponents: singleProcessingComponent('material', '100'),
      estimate: { priceT: '100', rateReal: '20' } };
    const first = freezeProcessingCostSnapshot(input);
    input.estimate.priceT = '99999';
    expect(freezeProcessingCostSnapshot(input)).toEqual(first);
    input.processingComponents.material = '50.00';
    expect((first as any).components.material).toBe('103.00');
  });

  it('preserves final multi-item surcharge rounding instead of recomputing a percentage', () => {
    expect(freeze('0.01', '0', singleProcessingComponent('material', '0.01')).materialSurcharge).toBe('0.00');
    expect(freeze('0.01', '0.01', singleProcessingComponent('material', '0.01')).materialSurcharge).toBe('0.01');
  });

  it('marks missing or inconsistent composition pending without changing the charged total', () => {
    for (const value of [undefined, singleProcessingComponent('material', '99'), pendingProcessingComponents('100')]) {
      const result: any = freezeProcessingCostSnapshot({ baseAmount: '100', surchargeAmount: '3', totalAmount: '103', processingComponents: value });
      expect(result).toMatchObject({ allocationPending: true, total: '103.00', components: { other: '103.00' } });
    }
  });

  it('accepts zero-value installments without inventing a cost', () => {
    expect(freeze('0', '0', singleProcessingComponent('material', '0'))).toMatchObject({ total: '0.00', materialSurcharge: '0.00' });
  });

  it('reuses frozen refund proportions as new principal without adding the old surcharge again', () => {
    const original = freeze('120', '3.60', { ...singleProcessingComponent('material', '100'), city: '20.00' });
    const remaining = refundedProcessingComponents(original, '60');
    expect(remaining).toEqual({ ...singleProcessingComponent('material', '50'), city: '10.00' });
    expect(freeze('60', '1.80', remaining)).toMatchObject({ total: '61.80', materialSurcharge: '1.50',
      components: { material: '51.50', city: '10.30' } });
    expect(refundedProcessingComponents(null, '60').allocationPending).toBe(true);
    expect(refundedProcessingComponents({ ...original, allocationPending: true }, '60').allocationPending).toBe(true);
  });
});

describe('Saved installment components', () => {
  it('allocates the installation deposit to the first material installment when the plan credits it there', () => {
    const values = { material: '300.00', installation: '180.00', permit: '0.00', city: '0.00' };
    const saved: PlanSnapshot = { version: 1, planId: 1, name: 'Material then installation', definition: {
      withInstallation: [{ milestone: 'ORDER', basis: 'MATERIAL', percent: 100 }, { milestone: 'INSTALL', basis: 'INSTALLATION', percent: 100 }],
      withoutInstallation: defaultPlan.withoutInstallation,
    } };
    const rows = planRows(saved, values, true);
    const deposit = advanceProcessingComponents({ snapshot: saved, amounts: values, withInstallation: true, amount: '100' });
    expect(deposit).toEqual(singleProcessingComponent('material', '100'));
    const remaining = rows.map((row, index) => installmentProcessingComponents({ snapshot: saved, amounts: values,
      withInstallation: true, row: { ...row, balance: index === 0 ? '200.00' : row.amount } }));
    expect(new Decimal(deposit.material).add(remaining[0].material).add(remaining[1].material).toFixed(2)).toBe('300.00');
    expect(new Decimal(deposit.installation).add(remaining[0].installation).add(remaining[1].installation).toFixed(2)).toBe('180.00');
  });

  it('conserves component cents when a deposit spans mixed project installments', () => {
    const saved = snapshot(project, { material: '0.03', installation: '0.03', permit: '0.00', city: '0.00' });
    const deposit = advanceProcessingComponents({ snapshot: saved, amounts: saved.locked!.amounts, withInstallation: true, amount: '0.04' });
    const second = components(saved, 2, '0.02');
    expect(new Decimal(deposit.material).add(second.material).toFixed(2)).toBe('0.03');
    expect(new Decimal(deposit.installation).add(second.installation).toFixed(2)).toBe('0.03');
    expect(advanceProcessingComponents({ snapshot: null, amounts, withInstallation: true, amount: '10' }).allocationPending).toBe(true);
  });

  it('separates custom charges from material across a material-only payment plan', () => {
    const definition = { ...defaultPlan, withoutInstallation: [
      { milestone: 'ORDER' as const, basis: 'MATERIAL' as const, percent: 50 },
      { milestone: 'RELEASE' as const, basis: 'MATERIAL' as const, percent: 50 },
    ] };
    const totals = { material: '120.00', installation: '0.00', permit: '0.00', city: '0.00' };
    const saved: PlanSnapshot = { version: 1, planId: 1, name: 'Material', definition };
    saved.locked = { amounts: totals, rows: planRows(saved, totals, false), at: '2026-01-01' };
    const allocated = saved.locked.rows.map(row => installmentProcessingComponents({
      snapshot: saved, amounts: { ...totals, material: '999.00' }, withInstallation: false,
      customMaterialAmount: '20.00', row: { ...row, balance: row.amount },
    }));
    expect(allocated).toEqual([
      { ...singleProcessingComponent('material', '50.00'), other: '10.00' },
      { ...singleProcessingComponent('material', '50.00'), other: '10.00' },
    ]);
    expect(freeze('60', '1.80', allocated[0])).toMatchObject({
      components: { material: '51.50', other: '10.30' }, materialSurcharge: '1.50',
    });
    expect(installmentProcessingComponents({ snapshot: saved, amounts: totals, withInstallation: false,
      customMaterialAmount: '20.00', row: { ...saved.locked.rows[0], balance: '30.00' },
    })).toEqual({ ...singleProcessingComponent('material', '25.00'), other: '5.00' });
  });

  it('does not subtract the same custom service again from a later material revision', () => {
    const totals = { material: '120.00', installation: '0.00', permit: '0.00', city: '0.00' };
    const saved: PlanSnapshot = { version: 1, planId: 1, name: 'Material', definition: defaultPlan };
    saved.locked = { amounts: totals, rows: planRows(saved, totals, false), at: '2026-01-01' };
    const row = { sequence: 101, milestone: 'ORDER' as const, title: 'Change', description: '', amount: '40.00',
      amounts: { ...totals, material: '160.00' }, planAdjustment: true };
    saved.adjustments = [row];
    expect(installmentProcessingComponents({ snapshot: saved, amounts: row.amounts, withInstallation: false,
      customMaterialAmount: '20.00', row: { ...row, balance: row.amount },
    })).toEqual(singleProcessingComponent('material', '40.00'));
  });

  it('conserves cents when splitting a tiny custom service over multiple installments', () => {
    const definition = { ...defaultPlan, withoutInstallation: [
      { milestone: 'ORDER' as const, basis: 'MATERIAL' as const, percent: 50 },
      { milestone: 'RELEASE' as const, basis: 'MATERIAL' as const, percent: 50 },
    ] };
    const totals = { material: '0.05', installation: '0.00', permit: '0.00', city: '0.00' };
    const saved: PlanSnapshot = { version: 1, planId: 1, name: 'Material', definition };
    const rows = planRows(saved, totals, false);
    const allocated = rows.map(row => installmentProcessingComponents({ snapshot: saved, amounts: totals,
      withInstallation: false, customMaterialAmount: '0.02', row: { ...row, balance: row.amount } }));
    expect(allocated.map(value => value.material)).toEqual(['0.02', '0.01']);
    expect(allocated.map(value => value.other)).toEqual(['0.01', '0.01']);
  });

  it('uses the saved PROJECT mixture, not current project totals', () => {
    expect(components(snapshot())).toEqual({ material: '50.00', installation: '30.00', permit: '10.00', city: '10.00', other: '0.00' });
  });

  it('proportionally allocates a remaining balance after credits or refunds', () => {
    expect(components(snapshot(), 1, '50.00')).toEqual({ material: '25.00', installation: '15.00', permit: '5.00', city: '5.00', other: '0.00' });
  });

  it('conserves both installment cents and total component cents in a PROJECT plan', () => {
    const value = snapshot(project, { material: '0.02', installation: '0.01', permit: '0.01', city: '0.01' });
    const first = components(value), second = components(value, 2);
    expect(first).toEqual({ material: '0.01', installation: '0.01', permit: '0.01', city: '0.00', other: '0.00' });
    expect(second).toEqual({ material: '0.01', installation: '0.00', permit: '0.00', city: '0.01', other: '0.00' });
  });

  it('assigns first-row permit and city amounts exactly for separate bases', () => {
    const value = snapshot(defaultPlan);
    expect(components(value)).toEqual({ material: '100.00', installation: '0.00', permit: '20.00', city: '20.00', other: '0.00' });
    expect(components(value, 2)).toEqual(singleProcessingComponent('installation', '60'));
  });

  it('retains separate components when material and installation share a milestone', () => {
    const definition: PlanDefinition = { ...project, withInstallation: [
      { milestone: 'ORDER', basis: 'MATERIAL', percent: 50 }, { milestone: 'ORDER', basis: 'INSTALLATION', percent: 50 },
      { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 }, { milestone: 'INSTALL', basis: 'INSTALLATION', percent: 50 },
    ] };
    expect(components(snapshot(definition))).toEqual({ material: '50.00', installation: '30.00', permit: '20.00', city: '20.00', other: '0.00' });
  });

  it('reconstructs each grouped adjustment from its delta, not its cumulative amounts', () => {
    const value = snapshot();
    const current = { ...amounts, material: '140.00', installation: '80.00' };
    value.adjustments = [
      { sequence: 101, milestone: 'ORDER', title: 'Change', description: '', amount: '30.00', amounts: current, planAdjustment: true },
      { sequence: 102, milestone: 'RELEASE', title: 'Change', description: '', amount: '30.00', amounts: current, planAdjustment: true },
    ];
    expect(components(value, 101)).toEqual({ material: '20.00', installation: '10.00', permit: '0.00', city: '0.00', other: '0.00' });
    expect(components(value, 102, '15.00')).toEqual({ material: '10.00', installation: '5.00', permit: '0.00', city: '0.00', other: '0.00' });
  });

  it('uses the immediately preceding adjustment amounts as the next revision base', () => {
    const value = snapshot();
    const first = { ...amounts, material: '140.00' }, second = { ...first, material: '140.00', installation: '100.00' };
    value.adjustments = [
      { sequence: 101, milestone: 'ORDER', title: '', description: '', amount: '20.00', amounts: first, planAdjustment: true },
      { sequence: 102, milestone: 'RELEASE', title: '', description: '', amount: '20.00', amounts: first, planAdjustment: true },
      { sequence: 103, milestone: 'ORDER', title: '', description: '', amount: '20.00', amounts: second, planAdjustment: true },
      { sequence: 104, milestone: 'RELEASE', title: '', description: '', amount: '20.00', amounts: second, planAdjustment: true },
    ];
    expect(components(value, 104)).toEqual(singleProcessingComponent('installation', '20'));
  });

  it('keeps a known City Fee adjustment entirely outside material', () => {
    const value = snapshot(); value.adjustments = [{ sequence: 101, kind: 'CITY_FEE', milestone: 'ORDER', title: '', description: '', amount: '10.00', amounts: { ...amounts, city: '30.00' } }];
    expect(components(value, 101, '5')).toEqual(singleProcessingComponent('city', '5'));
  });

  it('marks offsetting mixed revisions and legacy adjustments conservatively pending', () => {
    const value = snapshot(); value.adjustments = [{ sequence: 101, milestone: 'ORDER', title: '', description: '', amount: '30.00',
      amounts: { ...amounts, material: '200.00', installation: '20.00' }, planAdjustment: true }];
    expect(components(value, 101).allocationPending).toBe(true);
    delete value.adjustments[0].planAdjustment;
    expect(components(value, 101).allocationPending).toBe(true);
  });

  it('does not guess the composition of incompatible historic rows', () => {
    const value = snapshot(); value.locked!.rows[0].amount = '99.99';
    expect(components(value).allocationPending).toBe(true);
    expect(installmentProcessingComponents({ snapshot: null, amounts, withInstallation: true,
      row: { sequence: 1, milestone: 'ORDER', amount: '10', balance: '10' } }).allocationPending).toBe(true);
  });
});

describe('Payment context freezes composition without changing amounts', () => {
  function fixture() {
    const estimate: any = { id: 1, idUser: 1, number: '1001', units: 1, status: { name: 'Active' },
      dealerModeSnapshot: 'EXTERNAL', priceT: '100.00', totalPayable: '107.00', taxRate: '0.07',
      customerPriceT: '100.00', customerTotalPayable: '107.00', customerTaxRate: '0.07',
      user: { id: 1, parentDealerId: null, isActive: true, deletedAt: null, networkSuspended: false, role: { name: 'dealer' } },
      payments: [], installationJob: null, order: null };
    const tx: any = { estimate: { findUnique: jest.fn(async () => estimate), findUniqueOrThrow: jest.fn(async () => estimate) },
      globalParameter: { findUnique: jest.fn(async () => ({ value: '0.03' })) } };
    const service = new InstallationWorkflowService(tx, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { estimate, tx, service, user: { id: 1, role: { name: 'dealer' } } as any };
  }

  it('freezes tax-inclusive MATERIAL with the existing base and surcharge', async () => {
    const f = fixture(); const before = JSON.stringify(f.estimate);
    const context = await f.service.getPaymentContext(1, 'MATERIAL', undefined, undefined, f.user, f.tx, { preview: true });
    expect(context.baseAmount.toFixed(2)).toBe('107.00'); expect(context.totalAmount.toFixed(2)).toBe('110.21');
    expect(context.processingComponents).toEqual(singleProcessingComponent('material', '107'));
    expect(JSON.stringify(f.estimate)).toBe(before);
  });

  it('freezes a scheduled INSTALLMENT using its locked composition', async () => {
    const f = fixture(); const value: PlanSnapshot = { version: 1, planId: 1, name: 'Material plan', definition: defaultPlan };
    const saved = { material: '107.00', installation: '0.00', permit: '0.00', city: '0.00' };
    value.locked = { amounts: saved, rows: planRows(value, saved, false), at: '2026-01-01' };
    f.estimate.paymentPlanSnapshot = value;
    const context = await f.service.getPaymentContext(1, 'INSTALLMENT', 1, undefined, f.user, f.tx, { preview: true });
    expect(context.baseAmount.toFixed(2)).toBe('107.00');
    expect(context.processingComponents).toEqual(singleProcessingComponent('material', '107'));
  });

  it.each([false, true])('reuses a frozen material-refund composition or retains legacy pending (legacy=%s)', async legacy => {
    const f = fixture();
    const saved = freeze('120', '3.60', { ...singleProcessingComponent('material', '100'), city: '20.00' });
    f.estimate.payments.push({ type: 'MATERIAL', sequence: 1, status: 'PAID', baseAmount: '120', originalBaseAmount: '120',
      netPaidBaseAmount: '60', refundedAmount: '61.80', refundCreditAmount: '0', refundReviewPending: false,
      processingCostSnapshot: legacy ? null : saved });
    const context = await f.service.getPaymentContext(1, 'MATERIAL', 1, undefined, f.user, f.tx, { preview: true });
    expect(context.baseAmount.toFixed(2)).toBe('60.00'); expect(context.totalAmount.toFixed(2)).toBe('61.80');
    if (legacy) expect(context.processingComponents.allocationPending).toBe(true);
    else expect(context.processingComponents).toEqual({ ...singleProcessingComponent('material', '50'), city: '10.00' });
  });
});
