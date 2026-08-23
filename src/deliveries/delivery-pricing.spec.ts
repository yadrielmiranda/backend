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

    expect(result.additionalMiles.toFixed(2)).toBe('0.00');
    expect(result.total.toFixed(2)).toBe('200.00');
  });

  it('prorates the exact additional one-way mileage', () => {
    const result = calculateDeliveryPricing({
      distanceMeters: metersForMiles('30.01'),
      basePrice: 200,
      includedMiles: 30,
      additionalMilePrice: 5,
    });

    expect(result.additionalMiles.toFixed(2)).toBe('0.01');
    expect(result.total.toFixed(2)).toBe('200.05');
  });

  it('charges 5.60 additional miles for a 55.60-mile route', () => {
    const result = calculateDeliveryPricing({
      distanceMeters: metersForMiles('55.6'),
      basePrice: 500,
      includedMiles: 50,
      additionalMilePrice: 5,
    });

    expect(result.roadMiles.toFixed(2)).toBe('55.60');
    expect(result.additionalMiles.toFixed(2)).toBe('5.60');
    expect(result.subtotal.toFixed(2)).toBe('528.00');
    expect(result.total.toFixed(2)).toBe('528.00');
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

    expect(result.additionalMiles.toFixed(2)).toBe('2.20');
    expect(result.subtotal.toFixed(2)).toBe('534.40');
    expect(result.taxAmount.toFixed(2)).toBe('37.41');
    expect(result.total.toFixed(2)).toBe('571.81');
  });
});
