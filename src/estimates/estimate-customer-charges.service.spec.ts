import {
  DealerMode,
  EstimateCustomerChargeOrigin,
  EstimateCustomerChargePricingMode,
  EstimateCustomerChargeSource,
} from '@prisma/client';
import {
  buildEstimateCustomerChargeSummary,
  customerChargeDealerMode,
  internalCustomerChargeAdditions,
  internalCustomerChargeAdditionsForEstimate,
} from './estimate-customer-charges.service';

const externalDealerEstimate = {
  dealerModeSnapshot: DealerMode.EXTERNAL,
  status: { name: 'Active' },
  order: null,
  user: {
    dealerMode: DealerMode.EXTERNAL,
    role: { name: 'dealer' },
  },
};

const installation = {
  status: 'REQUESTED' as const,
  quoteStatus: 'DRAFT' as const,
  installationAmount: '2000.00',
  installationTotal: '2400.00',
  additionalServices: [
    { serviceId: 12, name: 'Remove shutters', amount: '400.00' },
  ],
  permitIncluded: false,
  permitFee: null,
  cityFee: null,
};

describe('external dealer customer charges', () => {
  it('defaults system-generated customer prices to the company price', () => {
    const summary = buildEstimateCustomerChargeSummary({
      estimate: externalDealerEstimate,
      installation,
      charges: [],
    });

    expect(summary?.systemTotal).toBe('2400.00');
    expect(summary?.customerTotal).toBe('2400.00');
    expect(summary?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: 'Installation',
          systemAmount: '2000.00',
          customerAmount: '2000.00',
          usedInCustomerQuote: true,
        }),
        expect.objectContaining({
          description: 'Remove shutters',
          systemAmount: '400.00',
          customerAmount: '400.00',
          usedInCustomerQuote: true,
        }),
      ]),
    );
  });

  it('supports percentage, fixed add-on and dealer-created prices without changing company cost', () => {
    const summary = buildEstimateCustomerChargeSummary({
      estimate: externalDealerEstimate,
      installation,
      charges: [
        {
          id: 1,
          origin: EstimateCustomerChargeOrigin.SYSTEM,
          source: EstimateCustomerChargeSource.INSTALLATION,
          sourceKey: 'INSTALLATION',
          sourceRefId: null,
          description: 'Installation',
          pricingMode: EstimateCustomerChargePricingMode.PERCENTAGE,
          pricingValue: 25,
          systemAmountSnapshot: 2000,
          sortOrder: 10,
        },
        {
          id: 2,
          origin: EstimateCustomerChargeOrigin.SYSTEM,
          source: EstimateCustomerChargeSource.INSTALLATION_SERVICE,
          sourceKey: 'SERVICE:12',
          sourceRefId: 12,
          description: 'Remove shutters',
          pricingMode: EstimateCustomerChargePricingMode.AMOUNT,
          pricingValue: 100,
          systemAmountSnapshot: 400,
          sortOrder: 100,
        },
        {
          id: 3,
          origin: EstimateCustomerChargeOrigin.DEALER,
          source: EstimateCustomerChargeSource.CUSTOM,
          sourceKey: null,
          sourceRefId: null,
          description: 'Dealer field service',
          pricingMode: EstimateCustomerChargePricingMode.FINAL,
          pricingValue: 300,
          systemAmountSnapshot: null,
          sortOrder: 1000,
        },
      ],
    });

    expect(summary?.systemTotal).toBe('2400.00');
    expect(summary?.customerTotal).toBe('3300.00');
    expect(summary?.knownSystemMargin).toBe('600.00');
    expect(summary?.dealerCreatedTotal).toBe('300.00');
  });

  it('allows a final dealer price without requesting company installation', () => {
    const summary = buildEstimateCustomerChargeSummary({
      estimate: externalDealerEstimate,
      installation: null,
      charges: [
        {
          id: 4,
          origin: EstimateCustomerChargeOrigin.DEALER,
          source: EstimateCustomerChargeSource.CUSTOM,
          sourceKey: null,
          sourceRefId: null,
          description: 'Installation',
          pricingMode: EstimateCustomerChargePricingMode.FINAL,
          pricingValue: 2750,
          systemAmountSnapshot: null,
          sortOrder: 1000,
        },
      ],
    });

    expect(summary?.systemTotal).toBe('0.00');
    expect(summary?.customerTotal).toBe('2750.00');
    expect(summary?.customerTotalIncomplete).toBe(false);
  });

  it('allows a final customer price while a company fee is pending', () => {
    const summary = buildEstimateCustomerChargeSummary({
      estimate: externalDealerEstimate,
      installation: {
        ...installation,
        permitIncluded: true,
        permitFee: '1000.00',
        cityFee: null,
      },
      charges: [
        {
          id: 5,
          origin: EstimateCustomerChargeOrigin.SYSTEM,
          source: EstimateCustomerChargeSource.CITY_FEE,
          sourceKey: 'CITY_FEE',
          sourceRefId: null,
          description: 'City Fee',
          pricingMode: EstimateCustomerChargePricingMode.FINAL,
          pricingValue: 250,
          systemAmountSnapshot: null,
          sortOrder: 910,
        },
      ],
    });

    expect(summary?.systemTotalIncomplete).toBe(true);
    expect(summary?.customerTotalIncomplete).toBe(false);
    expect(summary?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: EstimateCustomerChargeSource.CITY_FEE,
          systemAmount: null,
          customerAmount: '250.00',
        }),
      ]),
    );
  });

  it('can omit a system charge from the customer quote without removing the company charge', () => {
    const summary = buildEstimateCustomerChargeSummary({
      estimate: externalDealerEstimate,
      installation: {
        ...installation,
        permitIncluded: true,
        permitFee: '1000.00',
        cityFee: null,
      },
      charges: [
        {
          id: 7,
          origin: EstimateCustomerChargeOrigin.SYSTEM,
          source: EstimateCustomerChargeSource.PERMIT,
          sourceKey: 'PERMIT',
          sourceRefId: null,
          description: 'Permit Fee',
          pricingMode: EstimateCustomerChargePricingMode.FINAL,
          pricingValue: 1500,
          usedInCustomerQuote: true,
          systemAmountSnapshot: 1000,
          sortOrder: 900,
        },
        {
          id: 8,
          origin: EstimateCustomerChargeOrigin.SYSTEM,
          source: EstimateCustomerChargeSource.CITY_FEE,
          sourceKey: 'CITY_FEE',
          sourceRefId: null,
          description: 'City Fee',
          pricingMode: EstimateCustomerChargePricingMode.SAME,
          pricingValue: 0,
          usedInCustomerQuote: false,
          systemAmountSnapshot: null,
          sortOrder: 910,
        },
      ],
    });

    expect(summary?.systemTotalIncomplete).toBe(true);
    expect(summary?.customerTotalIncomplete).toBe(false);
    expect(summary?.customerTotal).toBe('3900.00');
    expect(summary?.knownSystemMargin).toBe('500.00');
    expect(summary?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: EstimateCustomerChargeSource.CITY_FEE,
          systemAmount: null,
          customerAmount: null,
          usedInCustomerQuote: false,
        }),
      ]),
    );
  });

  it('can bundle every company fee into one customer-facing installation price', () => {
    const summary = buildEstimateCustomerChargeSummary({
      estimate: externalDealerEstimate,
      installation: {
        ...installation,
        installationAmount: '1000.00',
        installationTotal: '1000.00',
        additionalServices: [],
        permitIncluded: true,
        permitFee: '1000.00',
        cityFee: '500.00',
      },
      charges: [
        {
          id: 9,
          origin: EstimateCustomerChargeOrigin.SYSTEM,
          source: EstimateCustomerChargeSource.INSTALLATION,
          sourceKey: 'INSTALLATION',
          sourceRefId: null,
          description: 'Installation',
          pricingMode: EstimateCustomerChargePricingMode.FINAL,
          pricingValue: 2500,
          usedInCustomerQuote: true,
          systemAmountSnapshot: 1000,
          sortOrder: 10,
        },
        {
          id: 10,
          origin: EstimateCustomerChargeOrigin.SYSTEM,
          source: EstimateCustomerChargeSource.PERMIT,
          sourceKey: 'PERMIT',
          sourceRefId: null,
          description: 'Permit Fee',
          pricingMode: EstimateCustomerChargePricingMode.SAME,
          pricingValue: 0,
          usedInCustomerQuote: false,
          systemAmountSnapshot: 1000,
          sortOrder: 900,
        },
        {
          id: 11,
          origin: EstimateCustomerChargeOrigin.SYSTEM,
          source: EstimateCustomerChargeSource.CITY_FEE,
          sourceKey: 'CITY_FEE',
          sourceRefId: null,
          description: 'City Fee',
          pricingMode: EstimateCustomerChargePricingMode.SAME,
          pricingValue: 0,
          usedInCustomerQuote: false,
          systemAmountSnapshot: 500,
          sortOrder: 910,
        },
      ],
    });

    expect(summary?.systemTotal).toBe('2500.00');
    expect(summary?.customerTotal).toBe('2500.00');
    expect(summary?.knownSystemMargin).toBe('0.00');
    expect(summary?.customerTotalIncomplete).toBe(false);
  });

  it('flags a saved customer rule when the underlying company cost changes', () => {
    const summary = buildEstimateCustomerChargeSummary({
      estimate: externalDealerEstimate,
      installation,
      charges: [
        {
          id: 6,
          origin: EstimateCustomerChargeOrigin.SYSTEM,
          source: EstimateCustomerChargeSource.INSTALLATION,
          sourceKey: 'INSTALLATION',
          sourceRefId: null,
          description: 'Installation',
          pricingMode: EstimateCustomerChargePricingMode.FINAL,
          pricingValue: 2500,
          systemAmountSnapshot: 1800,
          sortOrder: 10,
        },
      ],
    });

    expect(
      summary?.lines.find(
        (line) => line.source === EstimateCustomerChargeSource.INSTALLATION,
      )?.needsReview,
    ).toBe(true);
  });

  it('provides included base prices for internal dealers', () => {
    const summary = buildEstimateCustomerChargeSummary({
      estimate: {
        ...externalDealerEstimate,
        dealerModeSnapshot: DealerMode.INTERNAL,
        user: {
          ...externalDealerEstimate.user,
          dealerMode: DealerMode.INTERNAL,
        },
      },
      installation,
      charges: [],
    });

    expect(summary?.customerTotal).toBe('2400.00');
    expect(summary?.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'INSTALLATION', pricingMode: 'AMOUNT', pricingValue: '0.0000', usedInCustomerQuote: true }),
    ]));
  });
});

describe('internal dealer customer charges', () => {
  const estimate = {
    ...externalDealerEstimate,
    dealerModeSnapshot: DealerMode.INTERNAL,
    user: { ...externalDealerEstimate.user, dealerMode: DealerMode.INTERNAL },
  };
  const systemCharge = (source: EstimateCustomerChargeSource, value: number, mode: EstimateCustomerChargePricingMode = EstimateCustomerChargePricingMode.AMOUNT) => ({
    id: 1, origin: EstimateCustomerChargeOrigin.SYSTEM, source, sourceKey: source,
    sourceRefId: null, description: source, pricingMode: mode, pricingValue: value,
    systemAmountSnapshot: 2000, sortOrder: 10,
  });

  it('keeps company prices and allocates all internal additions to payable buckets', () => {
    const charges = [
      systemCharge(EstimateCustomerChargeSource.INSTALLATION, 25, EstimateCustomerChargePricingMode.PERCENTAGE),
      systemCharge(EstimateCustomerChargeSource.PERMIT, 40),
      systemCharge(EstimateCustomerChargeSource.CITY_FEE, 30),
      { ...systemCharge(EstimateCustomerChargeSource.INSTALLATION_SERVICE, 100), sourceKey: 'SERVICE:12', sourceRefId: 12 },
      { ...systemCharge(EstimateCustomerChargeSource.CUSTOM, 250, EstimateCustomerChargePricingMode.FINAL), origin: EstimateCustomerChargeOrigin.DEALER, sourceKey: null },
    ];
    const params = { estimate, installation: { ...installation, permitIncluded: true, permitFee: '100', cityFee: '200' }, charges };
    expect(buildEstimateCustomerChargeSummary(params)).toMatchObject({
      systemTotal: '2700.00', customerTotal: '3620.00', dealerCreatedTotal: '250.00',
    });
    expect(internalCustomerChargeAdditions(params)).toEqual({ installation: '600.00', permit: '40.00', city: '30.00', custom: '250.00' });
    expect(internalCustomerChargeAdditions({ ...params, estimate: externalDealerEstimate })).toEqual({ installation: '0.00', permit: '0.00', city: '0.00', custom: '0.00' });
  });

  it.each([EstimateCustomerChargePricingMode.FINAL, EstimateCustomerChargePricingMode.SAME])(
    'never replaces or omits the internal company base using a saved %s rule', (pricingMode) => {
      const summary = buildEstimateCustomerChargeSummary({
        estimate, installation,
        charges: [{ ...systemCharge(EstimateCustomerChargeSource.INSTALLATION, 1, pricingMode), usedInCustomerQuote: false }],
      });
      expect(summary?.customerTotal).toBe('2400.00');
      expect(summary?.lines[0]).toMatchObject({ customerAmount: '2000.00', pricingMode: 'AMOUNT', pricingValue: '0.0000', usedInCustomerQuote: true, needsReview: true });
    },
  );

  it('keeps a saved additive internal charge included even if a prior exclusion exists', () => {
    const summary = buildEstimateCustomerChargeSummary({ estimate, installation,
      charges: [{ ...systemCharge(EstimateCustomerChargeSource.INSTALLATION, 100), usedInCustomerQuote: false }],
    });
    expect(summary?.customerTotal).toBe('2500.00');
    expect(summary?.lines[0]).toMatchObject({ usedInCustomerQuote: true, needsReview: true });
  });

  it.each(['INTERNAL', 'EXTERNAL'] as const)('uses the saved %s owner mode in a dealer network', mode => {
    const networkEstimate = { ...estimate, dealerNetworkSnapshot: {
      version: 1, nodes: [{ id: 1, mode: 'INTERNAL' }, { id: 2, mode }],
      billingIndex: mode === 'INTERNAL' ? 2 : 1, billingAccountId: 2,
    } };
    expect(customerChargeDealerMode(networkEstimate)).toBe(mode);
  });

  it('preserves internal customer payment terms after a current account mode change', () => {
    expect(customerChargeDealerMode({ ...estimate,
      user: { ...estimate.user, dealerMode: DealerMode.EXTERNAL },
      payments: [{ status: 'PAID' }],
    })).toBe(DealerMode.INTERNAL);
  });

  it('tolerates legacy payment selections when no charges exist and absent quote lines otherwise', () => {
    expect(internalCustomerChargeAdditionsForEstimate({})).toEqual({ installation: '0.00', permit: '0.00', city: '0.00', custom: '0.00' });
    expect(internalCustomerChargeAdditionsForEstimate({ ...estimate,
      customerCharges: [systemCharge(EstimateCustomerChargeSource.INSTALLATION, 100)],
      installationJob: { status: 'APPROVED', quotes: [{ status: 'APPROVED', total: '2000' }], permit: null },
    }).installation).toBe('100.00');
  });
});
