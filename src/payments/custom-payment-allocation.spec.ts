import Decimal from 'decimal.js';
import { allocateCustomPayment, installmentObligation, partialProcessingComponents } from './custom-payment-allocation';

const schedule = {
  fullBalance: { amount: '10641.28', sequences: [1, 2] },
  rows: [{ sequence: 1, milestone: 'ORDER', balance: '5320.64' }, { sequence: 2, milestone: 'RELEASE', balance: '5320.64' }],
};

describe('custom principal allocation', () => {
  it('applies 8000 to the first installment and part of the second with exact cents', () => {
    expect(allocateCustomPayment(schedule, 8000, 10641.28)).toEqual([
      { sequence: 1, amount: '5320.64' }, { sequence: 2, amount: '2679.36' },
    ]);
    expect(allocateCustomPayment(schedule, 0.01, 10641.28)).toEqual([{ sequence: 1, amount: '0.01' }]);
  });
  it('orders milestones before sequence, including approved City Fee adjustments', () => {
    expect(allocateCustomPayment({ fullBalance: { amount: '400.00', sequences: [2, 3, 101] }, rows: [
      { sequence: 2, milestone: 'RELEASE', balance: '200.00' },
      { sequence: 3, milestone: 'COMPLETE', balance: '100.00' },
      { sequence: 101, milestone: 'ORDER', balance: '100.00' },
    ] }, 150, 400)).toEqual([{ sequence: 101, amount: '100.00' }, { sequence: 2, amount: '50.00' }]);
  });
  it('keeps the required zero confirmation and does not include rows after the amount is allocated', () => {
    expect(allocateCustomPayment({ ...schedule, fullBalance: { amount: '5320.64', sequences: [1, 2] },
      rows: [{ ...schedule.rows[0], balance: '0.00' }, schedule.rows[1]] }, 100, 5320.64))
      .toEqual([{ sequence: 1, amount: '0.00' }, { sequence: 2, amount: '100.00' }]);
    expect(allocateCustomPayment(schedule, 5320.64, 10641.28)).toEqual([{ sequence: 1, amount: '5320.64' }]);
  });
  it.each([0, -1, 0.001, NaN, Infinity, 10641.29])('rejects invalid or excessive principal %s', value => {
    expect(() => allocateCustomPayment(schedule, value, 10641.28)).toThrow();
  });
  it('rejects stale balances and unapproved/unavailable schedules', () => {
    expect(() => allocateCustomPayment(schedule, 1, 10641.27)).toThrow('balance changed');
    expect(() => allocateCustomPayment(schedule, 1)).toThrow('Review');
    expect(() => allocateCustomPayment({ ...schedule, fullBalance: null }, 1, 10641.28)).toThrow('not available');
  });
  it('uses only approved schedule rows and rejects an inconsistent total', () => {
    expect(() => allocateCustomPayment({ ...schedule, fullBalance: { amount: '10641.28', sequences: [1] } }, 8000, 10641.28))
      .toThrow('installment balance changed');
  });
  it('keeps proportional processing components exact for a partial receipt', () => {
    const result = partialProcessingComponents({ material: '3000.00', installation: '2000.00', permit: '300.00', city: '20.64', other: '0.00' }, new Decimal('2679.36'));
    expect(Object.values(result).reduce((sum: Decimal, amount) => sum.add(String(amount)), new Decimal(0)).toFixed(2)).toBe('2679.36');
    expect(new Decimal(result.material).gt(0)).toBe(true);
  });
  it('preserves the installment obligation across several receipts and approved refunds', () => {
    expect(installmentObligation(new Decimal('5320.64')).toFixed(2)).toBe('5320.64');
    expect(installmentObligation(new Decimal('2641.28'), { netPaidBaseAmount: '2679.36' }).toFixed(2)).toBe('5320.64');
    expect(installmentObligation(new Decimal('2541.28'), { netPaidBaseAmount: '2679.36', refundCreditAmount: '100.00' }).toFixed(2)).toBe('5320.64');
  });
});
