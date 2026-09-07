import {
  calculateEstimateDiscount,
  discountAllocations,
} from './estimate-discount';

const fixture = (scope = 'PROJECT', type = 'PERCENTAGE', value = '10') => ({
  manualDiscount: { scope, type, value },
  dealerModeSnapshot: 'EXTERNAL',
  priceT: '1000',
  totalPayable: '1070',
  taxRate: '.07',
  customerPriceT: '2000',
  customerTotalPayable: '2140',
  customerTaxRate: '.07',
  installationJob: {
    status: 'REQUESTED',
    quotes: [{ status: 'DRAFT', total: '200' }],
    permit: { permitFeeSnapshot: '100', cityFee: '30' },
  },
});

describe('Manual estimate discount totals', () => {
  it('discounts the full project once and reconciles every payment bucket', () => {
    const estimate = fixture();
    const before = JSON.stringify(estimate);
    const result = calculateEstimateDiscount(estimate)!;
    expect(result).toMatchObject({
      base: '1400.00',
      discount: '140.00',
      projectTotal: '1260.00',
      material: {
        total: '963.00',
        subtotal: '900.00',
        tax: '63.00',
        netDiscount: '100.00',
      },
      installation: { total: '180.00' },
      permit: { total: '90.00' },
      city: { total: '27.00' },
    });
    expect(JSON.stringify(estimate)).toBe(before);
  });
  it('discounts the material subtotal after promotions, then calculates tax', () => {
    const result = calculateEstimateDiscount(fixture('MATERIAL'))!;
    expect(result.base).toBe('1000.00');
    expect(result.discount).toBe('100.00');
    expect(result.material).toMatchObject({
      netDiscount: '100.00',
      subtotal: '900.00',
      tax: '63.00',
      total: '963.00',
    });
    expect(result.installation.total).toBe('200.00');
    expect(result.projectTotal).toBe('1293.00');
  });
  it('limits an installation discount to installation, preserving permit and city fees', () => {
    const result = calculateEstimateDiscount(fixture('INSTALLATION'))!;
    expect(result.discount).toBe('20.00');
    expect(result.material.total).toBe('1070.00');
    expect(result.permit.total).toBe('100.00');
    expect(result.city.total).toBe('30.00');
    expect(result.projectTotal).toBe('1380.00');
  });
  it.each(['MATERIAL', 'INSTALLATION'])(
    'applies a fixed discount entirely to %s, with no allocation to other charges',
    (scope) => {
      const result = calculateEstimateDiscount(fixture(scope, 'AMOUNT', '20'))!;
      expect(discountAllocations(result)).toEqual({
        material: scope === 'MATERIAL' ? '21.40' : '0.00',
        installation: scope === 'INSTALLATION' ? '20.00' : '0.00',
        permit: '0.00',
        city: '0.00',
      });
      expect(result.discount).toBe('20.00');
      expect(result.projectTotal).toBe(
        scope === 'MATERIAL' ? '1378.60' : '1380.00',
      );
    },
  );
  it.each([
    null,
    { status: 'CANCELED', quotes: [{ status: 'DRAFT', total: '200' }] },
    { status: 'DEPOSIT_PAYMENT_PENDING', quotes: [] },
    {
      status: 'DEPOSIT_PAYMENT_PENDING',
      quotes: [{ status: 'REJECTED', total: '200' }],
    },
    {
      status: 'DEPOSIT_PAYMENT_PENDING',
      quotes: [{ status: 'DRAFT', total: '0' }],
    },
  ])(
    'does not apply an installation discount without a positive active total: %j',
    (job) => {
      const estimate: any = fixture('INSTALLATION', 'AMOUNT', '20');
      estimate.installationJob = job;
      expect(calculateEstimateDiscount(estimate)).toBeNull();
      estimate.manualDiscount.scope = 'MATERIAL';
      expect(calculateEstimateDiscount(estimate)!.material.total).toBe(
        '1048.60',
      );
    },
  );
  it('preserves the old project amount until an explicit replacement is saved', () => {
    const estimate: any = fixture('PROJECT', 'AMOUNT', '20');
    estimate.installationJob = null;
    expect(calculateEstimateDiscount(estimate)).toMatchObject({
      scope: 'PROJECT',
      discount: '20.00',
      projectTotal: '1050.00',
    });
    expect(estimate.manualDiscount.scope).toBe('PROJECT');
  });
  it.each(['PROJECT', 'MATERIAL', 'INSTALLATION'])(
    'allocates a fixed amount exactly for %s',
    (scope) => {
      const result = calculateEstimateDiscount(
        fixture(scope, 'AMOUNT', '12.37'),
      )!;
      expect(result.discount).toBe('12.37');
      expect(result.projectTotal).toBe(
        scope === 'MATERIAL' ? '1386.76' : '1387.63',
      );
      expect(
        Object.values(discountAllocations(result)).reduce(
          (sum, n) => sum + Math.round(Number(n) * 100),
          0,
        ),
      ).toBe(scope === 'MATERIAL' ? 1324 : 1237);
      expect(
        Math.round(
          (Number(result.material.subtotal) + Number(result.material.tax)) *
            100,
        ),
      ).toBe(Math.round(Number(result.material.total) * 100));
    },
  );
  it('uses customer totals for an internal dealer and owner totals for external dealers', () => {
    const estimate = fixture('MATERIAL');
    expect(calculateEstimateDiscount(estimate)!.material.total).toBe('963.00');
    estimate.dealerModeSnapshot = 'INTERNAL';
    expect(calculateEstimateDiscount(estimate)!.material.total).toBe('1926.00');
  });
  it.each(['PROJECT', 'MATERIAL', 'INSTALLATION'])(
    'supports 100%% on %s without negative totals',
    (scope) => {
      const result = calculateEstimateDiscount(
        fixture(scope, 'PERCENTAGE', '100'),
      )!;
      for (const bucket of [
        'material',
        'installation',
        'permit',
        'city',
      ] as const)
        expect(Number(result[bucket].total)).toBeGreaterThanOrEqual(0);
      if (scope === 'PROJECT') expect(result.projectTotal).toBe('0.00');
    },
  );
  it('preserves paid allocations even after a measured revision increases prices', () => {
    const estimate: any = fixture();
    const result = calculateEstimateDiscount(estimate)!;
    estimate.manualDiscount = {
      ...estimate.manualDiscount,
      lockedAt: '2026-09-07T12:00:00Z',
      allocations: discountAllocations(result),
    };
    estimate.priceT = '2000';
    estimate.totalPayable = '2140';
    estimate.installationJob.quotes[0].total = '400';
    const revised = calculateEstimateDiscount(estimate)!;
    expect(discountAllocations(revised)).toEqual(discountAllocations(result));
    expect(revised.discount).toBe('140.00');
  });
  it('uses revised totals while unpaid and caps a fixed discount if the scope shrinks', () => {
    const estimate = fixture('MATERIAL', 'AMOUNT', '900');
    estimate.priceT = '100';
    estimate.totalPayable = '107';
    const result = calculateEstimateDiscount(estimate)!;
    expect(result.material.total).toBe('0.00');
    expect(result.discount).toBe('100.00');
  });
  it('excludes canceled installation and unknown City Fee amounts', () => {
    const estimate: any = fixture();
    estimate.installationJob.permit.cityFee = null;
    expect(calculateEstimateDiscount(estimate)!.base).toBe('1370.00');
    estimate.installationJob.status = 'CANCELED';
    expect(calculateEstimateDiscount(estimate)!.base).toBe('1070.00');
  });
  it('keeps tax-exempt and no-discount estimates unchanged', () => {
    const estimate: any = fixture('MATERIAL');
    estimate.taxRate = '0';
    estimate.totalPayable = '1000';
    expect(calculateEstimateDiscount(estimate)!.material).toMatchObject({
      total: '900.00',
      subtotal: '900.00',
      tax: '0.00',
    });
    estimate.manualDiscount = null;
    expect(calculateEstimateDiscount(estimate)).toBeNull();
  });
  it('subtracts the exact $20 first in the reported example', () => {
    const estimate: any = fixture('MATERIAL', 'AMOUNT', '20');
    Object.assign(estimate, {
      priceT: '100.33',
      totalPayable: '107.35',
      installationJob: null,
    });
    const before = JSON.stringify(estimate);
    expect(calculateEstimateDiscount(estimate)).toMatchObject({
      base: '100.33',
      discount: '20.00',
      projectTotal: '85.95',
      material: {
        netDiscount: '20.00',
        subtotal: '80.33',
        tax: '5.62',
        total: '85.95',
      },
    });
    expect(JSON.stringify(estimate)).toBe(before);
  });
  it('rounds percentages before calculating the tax on the remaining cents', () => {
    const estimate: any = fixture('MATERIAL', 'PERCENTAGE', '12.5');
    Object.assign(estimate, {
      priceT: '100.33',
      totalPayable: '107.35',
      installationJob: null,
    });
    expect(calculateEstimateDiscount(estimate)).toMatchObject({
      discount: '12.54',
      material: { subtotal: '87.79', tax: '6.15', total: '93.94' },
    });
  });
  it('preserves earlier paid and pending checkout amounts and corrects canceled unpaid terms', () => {
    const estimate: any = fixture('MATERIAL', 'AMOUNT', '20');
    Object.assign(estimate, {
      priceT: '100.33',
      totalPayable: '107.35',
      installationJob: null,
      payments: [{ status: 'PENDING' }],
    });
    estimate.manualDiscount.checkoutAllocations = {
      material: '20.00',
      installation: '0.00',
      permit: '0.00',
      city: '0.00',
    };
    expect(calculateEstimateDiscount(estimate)!.material.total).toBe('87.35');
    estimate.payments[0].status = 'CANCELED';
    expect(calculateEstimateDiscount(estimate)!.material.total).toBe('85.95');
    estimate.manualDiscount.lockedAt = '2026-09-07T12:00:00Z';
    estimate.manualDiscount.allocations =
      estimate.manualDiscount.checkoutAllocations;
    expect(calculateEstimateDiscount(estimate)!.material.total).toBe('87.35');
  });
});
