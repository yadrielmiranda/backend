import { buildPublicEstimateData } from '@/estimates/public-share/public-estimate-data';
import { agreementScopes, buildChangeOrder } from './agreement-content';

function internalEstimate(): any {
  return {
    id: 1,
    idUser: 7,
    user: { role: { name: 'dealer' }, dealerMode: 'INTERNAL' },
    dealerModeSnapshot: 'INTERNAL',
    status: { name: 'Active' },
    customerPriceT: '1000.00',
    customerTaxRate: '0',
    customerTaxAmount: '0.00',
    customerTotalPayable: '1000.00',
    customerCharges: [],
    pieces: [],
    manualDiscount: { scope: 'INSTALLATION', type: 'AMOUNT', value: '50' },
    installationJob: {
      status: 'REQUESTED',
      quotes: [{ status: 'DRAFT', total: '500', lines: [], serviceMinimumsSnapshot: [] }],
      permit: { permitFeeSnapshot: '100', cityFee: '50' },
    },
  };
}

function addCustomerCharges(estimate: any) {
  estimate.customerCharges = [
    { id: 1, origin: 'SYSTEM', source: 'INSTALLATION', sourceKey: 'INSTALLATION',
      sourceRefId: null, description: 'Installation', pricingMode: 'PERCENTAGE',
      pricingValue: '20', usedInCustomerQuote: true, systemAmountSnapshot: '500', sortOrder: 10 },
    { id: 2, origin: 'DEALER', source: 'CUSTOM', sourceKey: null,
      sourceRefId: null, description: 'Site preparation', pricingMode: 'FINAL',
      pricingValue: '125', usedInCustomerQuote: true, systemAmountSnapshot: null, sortOrder: 1000 },
  ];
}

describe('Internal dealer customer charges in public agreements', () => {
  it('preserves the prior public shape when customer installation prices are unchanged', () => {
    const estimate = internalEstimate();
    const publicEstimate = buildPublicEstimateData(estimate, null, [], 'detailed');
    expect(publicEstimate.customerChargesSummary).toBeNull();
    expect(publicEstimate.installationSummary?.installationAmount).toBe('500.00');
    expect(agreementScopes(publicEstimate).charges.projectTotal).toBe('1600.00');

    addCustomerCharges(estimate);
    estimate.customerCharges = [{ ...estimate.customerCharges[0], pricingValue: '0' }];
    expect(buildPublicEstimateData(estimate, null, [], 'detailed')).toEqual(publicEstimate);
  });

  it.each([false, true])('includes markup and custom charges in customer totals and agreements (subdealer: %s)', (subdealer) => {
    const estimate = internalEstimate();
    if (subdealer) Object.assign(estimate, {
      networkBillingPriceT: '1000',
      dealerNetworkSnapshot: {
        version: 1, rootMode: 'INTERNAL', rootMarkup: '0',
        nodes: [{ id: 3, mode: 'INTERNAL' }, { id: 7, mode: 'INTERNAL' }],
        payerType: 'CUSTOMER', billingIndex: 2, billingAccountId: 7, billingTaxRate: '0',
      },
    });
    addCustomerCharges(estimate);
    const detailed = buildPublicEstimateData(estimate, null, [], 'detailed');
    const total = buildPublicEstimateData(estimate, null, [], 'total');
    expect(detailed.customerChargesSummary?.customerTotal).toBe('875.00');
    expect(detailed.manualDiscountSummary?.installation.discount).toBe('50.00');
    expect(detailed.installationSummary?.installationAmount).toBe('0.00');
    expect(detailed.customerChargesSummary?.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: 'Installation', customerAmount: '600.00', systemAmount: null }),
      expect.objectContaining({ description: 'Site preparation', customerAmount: '125.00', systemAmount: null }),
    ]));
    expect(agreementScopes(detailed).charges).toMatchObject({ total: '825.00', projectTotal: '1825.00' });
    expect(total.publicProjectTotal).toBe(1825);
    expect(total.customerChargesSummary?.customerTotal).toBe('0.00');
    expect(total.customerChargesSummary?.lines.every(line => line.customerAmount === '0.00')).toBe(true);
  });

  it('creates a charge-only change order for internal installation markup and custom charges', () => {
    const estimate = internalEstimate();
    const before = agreementScopes(buildPublicEstimateData(estimate, null, [], 'detailed'));
    addCustomerCharges(estimate);
    const after = agreementScopes(buildPublicEstimateData(estimate, null, [], 'detailed'));
    expect(after.materialHash).toBe(before.materialHash);
    const change = buildChangeOrder({ id: 'signed', revision: 1 }, before.charges, after.charges, 1, 'detailed');
    expect(change).toMatchObject({ previousTotal: '1600.00', newTotal: '1825.00', difference: '225.00' });
    expect(change.changedCharges).toEqual(['Installation', 'Site preparation']);
  });

  it('keeps custom charges when the dealer removes the installation', () => {
    const estimate = internalEstimate();
    addCustomerCharges(estimate);
    estimate.installationJob = null;
    const detailed = buildPublicEstimateData(estimate, null, [], 'detailed');
    expect(detailed.installationSummary).toBeNull();
    expect(detailed.customerChargesSummary?.lines).toHaveLength(1);
    expect(agreementScopes(detailed).charges.projectTotal).toBe('1125.00');
    expect(buildPublicEstimateData(estimate, null, [], 'total').publicProjectTotal).toBe(1125);
  });
});
