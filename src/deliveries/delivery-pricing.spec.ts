import { calculateDeliveryPricing, METERS_PER_MILE } from './delivery-pricing';

describe('delivery pricing', () => {
  const metersForMiles = (miles: string) =>
    METERS_PER_MILE.mul(miles).round().toNumber();

  it('charges only the base price through the included miles', () => {
    const result = calculateDeliveryPricing({
      distanceMeters: metersForMiles('30'),
      basePrice: 200,
      includedMiles: 30,
      additionalMilePrice: 5,
    });

    expect(result.additionalMiles).toBe(0);
    expect(result.total.toFixed(2)).toBe('200.00');
  });

  it('rounds only additional one-way miles upward', () => {
    const result = calculateDeliveryPricing({
      distanceMeters: metersForMiles('30.01'),
      basePrice: 200,
      includedMiles: 30,
      additionalMilePrice: 5,
    });

    expect(result.additionalMiles).toBe(1);
    expect(result.total.toFixed(2)).toBe('205.00');
  });

  it('keeps the fixed formula when configuration values change', () => {
    const result = calculateDeliveryPricing({
      distanceMeters: metersForMiles('52.2'),
      basePrice: 500,
      includedMiles: 50,
      additionalMilePrice: 12,
      tollAmount: 8,
      taxRate: '0.07',
    });

    expect(result.additionalMiles).toBe(3);
    expect(result.subtotal.toFixed(2)).toBe('544.00');
    expect(result.taxAmount.toFixed(2)).toBe('38.08');
    expect(result.total.toFixed(2)).toBe('582.08');
  });
});
