import { stripePaymentMethod } from './stripe-payment-method';
import { distributeCents } from './payment-accounting';

describe('Actual Stripe funding source', () => {
  it.each([
    [{ type: 'card', card: { brand: 'visa' } }, 'CARD', 'Card'],
    [{ type: 'us_bank_account' }, 'ACH', 'Bank (ACH)'],
    [
      { type: 'link', link: { funding_source_group: 'lfsg_003' } },
      'BANK',
      'Bank (Link)',
    ],
    [
      {
        type: 'card',
        card: {
          brand: 'link',
          wallet: { type: 'link', link: { funding_source_group: 'lfsg_003' } },
        },
      },
      'BANK',
      'Bank (Link)',
    ],
    [
      { type: 'link', link: { funding_source_group: 'lfsg_000' } },
      'CARD',
      'Card (Link)',
    ],
    [{ type: 'card', card: { brand: 'link' } }, 'OTHER', 'Link'],
    [{ type: 'link' }, 'OTHER', 'Link'],
    [
      { type: 'link', link: { funding_source_group: 'lfsg_001' } },
      'OTHER',
      'Link',
    ],
    [
      { type: 'link', link: { funding_source_group: 'lfsg_002' } },
      'OTHER',
      'Link',
    ],
    [
      { type: 'link', link: { funding_source_group: 'lfsg_004' } },
      'OTHER',
      'Klarna (Link)',
    ],
    [null, 'OTHER', 'Stripe'],
  ])(
    'classifies %j from confirmed charge details',
    (details, method, label) => {
      expect(
        stripePaymentMethod({ payment_method_details: details } as any),
      ).toMatchObject({ paymentMethod: method, paymentMethodLabel: label });
    },
  );
});

describe('Exact refund allocation', () => {
  it('preserves every cent with surcharges and several installments', () => {
    expect(distributeCents(10000, [400000, 12000])).toEqual([9709, 291]);
    expect(distributeCents(7, [2, 3, 5])).toEqual([1, 2, 4]);
  });
  it('never exceeds captured amounts for many consecutive partial refunds', () => {
    let capacities = [100003, 3000, 29001, 870, 17403, 522];
    const original = capacities.reduce((s, n) => s + n, 0);
    let refunded = 0;
    for (const part of [1, 9, 7, 54327, 126, 30003, 3]) {
      const amounts = distributeCents(part, capacities);
      expect(amounts.reduce((s, n) => s + n, 0)).toBe(part);
      capacities = capacities.map((c, i) => c - amounts[i]);
      expect(capacities.every((n) => n >= 0)).toBe(true);
      refunded += part;
    }
    expect(capacities.reduce((s, n) => s + n, 0) + refunded).toBe(original);
  });
  it('keeps exact arithmetic at the database money limit', () => {
    const capacities = [999999999999, 999999999998, 1];
    const parts = distributeCents(1999999999997, capacities);
    expect(parts.reduce((s, n) => s + n, 0)).toBe(1999999999997);
    expect(parts.every((n, i) => n <= capacities[i])).toBe(true);
  });
  it('rejects excessive or invalid allocations', () => {
    expect(() => distributeCents(11, [5, 5])).toThrow();
    expect(() => distributeCents(1, [-1, 5])).toThrow();
    expect(() => distributeCents(0.5, [1])).toThrow();
  });
});
