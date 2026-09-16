import { buildInstallationRevisionComparison } from './installation-revision-comparison';

const totals = (
  priceT = '306.94',
  taxAmount = '21.49',
  totalPayable = '328.43',
) => ({
  units: 2,
  priceT,
  taxAmount,
  totalPayable,
  taxRate: '0.07',
  customerPriceT: priceT,
  customerTaxAmount: taxAmount,
  customerTotalPayable: totalPayable,
  customerTaxRate: '0.07',
});

function fixture() {
  return {
    estimate: {
      ...totals(),
      dealerModeSnapshot: null as string | null,
      manualDiscount: null as unknown,
    },
    quotes: [
      {
        id: 2,
        version: 2,
        status: 'PENDING_CUSTOMER_APPROVAL',
        total: '500',
        submittedAt: '2026-09-15',
        approvedAt: null as string | null,
      },
      {
        id: 1,
        version: 1,
        status: 'SUPERSEDED',
        total: '500',
        submittedAt: null as string | null,
        approvedAt: null as string | null,
      },
    ],
    revisions: [
      {
        id: 7,
        quoteId: 2,
        originalTotals: totals(),
        revisedTotals: totals('307.86', '21.55', '329.41'),
      },
    ],
    permit: null as {
      permitFeeSnapshot: string;
      cityFee: string | null;
    } | null,
    payments: [
      { type: 'INSTALLATION_DEPOSIT', status: 'PAID', baseAmount: '250' },
    ],
  };
}

describe('Installation revision comparison', () => {
  it('compares the saved material and installation totals without subtracting the deposit', () => {
    const job = fixture();
    const before = JSON.stringify(job);
    expect(buildInstallationRevisionComparison(job)).toMatchObject({
      revisionId: 7,
      originalQuoteId: 1,
      revisedQuoteId: 2,
      includesPermit: false,
      cityFeePending: false,
      original: {
        units: 2,
        materialTotal: '328.43',
        installationTotal: '500.00',
        projectTotal: '828.43',
        permitFee: null,
      },
      revised: {
        units: 2,
        materialTotal: '329.41',
        installationTotal: '500.00',
        projectTotal: '829.41',
      },
      difference: '0.98',
    });
    expect(JSON.stringify(job)).toBe(before);
  });

  it('includes installation changes in the total difference', () => {
    const job = fixture();
    job.quotes[0].total = '600';
    expect(buildInstallationRevisionComparison(job)?.difference).toBe('100.98');
  });

  it('uses the most recent accepted quote, skipping later rejected attempts', () => {
    const job = fixture();
    job.quotes[0].version = 4;
    job.quotes.push(
      {
        id: 8,
        version: 2,
        status: 'SUPERSEDED',
        total: '400',
        submittedAt: '2026-09-13',
        approvedAt: '2026-09-14',
      },
      {
        id: 9,
        version: 3,
        status: 'SUPERSEDED',
        total: '900',
        submittedAt: '2026-09-14',
        approvedAt: null,
      },
    );
    expect(buildInstallationRevisionComparison(job)).toMatchObject({
      originalQuoteId: 8,
      difference: '100.98',
    });
  });

  it('preserves the original comparison after the revision has been applied', () => {
    const job = fixture();
    Object.assign(job.estimate, job.revisions[0].revisedTotals);
    job.quotes[0].status = 'APPROVED';
    job.quotes[0].approvedAt = '2026-09-15';
    expect(
      buildInstallationRevisionComparison(job)?.original.materialTotal,
    ).toBe('328.43');
  });

  it('applies the material discount before tax on both saved versions', () => {
    const job = fixture();
    job.revisions[0].originalTotals = totals('1000', '70', '1070');
    job.revisions[0].revisedTotals = totals('1200', '84', '1284');
    job.estimate.manualDiscount = {
      scope: 'MATERIAL',
      type: 'AMOUNT',
      value: '20',
      materialDiscountBasis: 'BEFORE_TAX',
    };
    expect(buildInstallationRevisionComparison(job)).toMatchObject({
      original: {
        materialSubtotal: '980.00',
        materialTax: '68.60',
        projectTotal: '1548.60',
      },
      revised: {
        materialSubtotal: '1180.00',
        materialTax: '82.60',
        projectTotal: '1762.60',
        discountApplied: true,
      },
      difference: '214.00',
    });
  });

  it('preserves the agreed installation discount after payment', () => {
    const job = fixture();
    job.quotes[0].total = '600';
    job.estimate.manualDiscount = {
      scope: 'INSTALLATION',
      type: 'PERCENTAGE',
      value: '10',
      lockedAt: '2026-09-15',
      allocations: {
        material: '0',
        installation: '50',
        permit: '0',
        city: '0',
      },
    };
    expect(buildInstallationRevisionComparison(job)).toMatchObject({
      original: { installationTotal: '450.00' },
      revised: { installationTotal: '550.00' },
      difference: '100.98',
    });
  });

  it.each(['INTERNAL', 'EXTERNAL'])(
    'uses the correct payer prices for %s dealers',
    (mode) => {
      const job = fixture();
      job.estimate.dealerModeSnapshot = mode;
      Object.assign(job.revisions[0].originalTotals, {
        customerPriceT: '1000',
        customerTaxAmount: '70',
        customerTotalPayable: '1070',
      });
      Object.assign(job.revisions[0].revisedTotals, {
        customerPriceT: '1200',
        customerTaxAmount: '84',
        customerTotalPayable: '1284',
      });
      expect(buildInstallationRevisionComparison(job)).toMatchObject({
        accountCost: mode === 'EXTERNAL',
        difference: mode === 'INTERNAL' ? '214.00' : '0.98',
        original: { projectTotal: mode === 'INTERNAL' ? '1570.00' : '828.43' },
      });
    },
  );

  it.each([null, '0', '100'])(
    'includes permit fees and represents a City Fee of %s correctly',
    (cityFee) => {
      const job = fixture();
      job.permit = { permitFeeSnapshot: '200', cityFee };
      expect(buildInstallationRevisionComparison(job)).toMatchObject({
        includesPermit: true,
        cityFeePending: cityFee === null,
        original: {
          projectTotal: cityFee === '100' ? '1128.43' : '1028.43',
          cityFee: cityFee === null ? null : `${cityFee}.00`,
        },
        difference: '0.98',
      });
    },
  );

  it.each(['500', '400'])(
    'shows an unchanged or lower total when installation is %s',
    (installation) => {
      const job = fixture();
      job.revisions[0].revisedTotals = totals();
      job.quotes[0].total = installation;
      expect(buildInstallationRevisionComparison(job)?.difference).toBe(
        installation === '500' ? '0.00' : '-100.00',
      );
    },
  );

  it('does not invent an original installation total when the saved quote is missing', () => {
    const job = fixture();
    job.quotes.pop();
    expect(buildInstallationRevisionComparison(job)).toMatchObject({
      originalQuoteId: null,
      original: { installationTotal: null, projectTotal: null },
      difference: null,
    });
  });

  it('does not attach an older revision to the latest quote', () => {
    const job = fixture();
    job.revisions[0].quoteId = 1;
    expect(buildInstallationRevisionComparison(job)).toBeNull();
  });
});
