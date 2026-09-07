import { EstimatePublicShareService } from './estimate-public-share.service';
import { EstimateCustomerChargesService } from '../estimate-customer-charges.service';

function sharedEstimateFixture() {
  return {
    id: 9,
    idUser: 44,
    number: '190918',
    name: 'Replacement windows',
    date: new Date('2026-08-18T12:00:00.000Z'),
    expiresAt: new Date('2026-09-17T12:00:00.000Z'),
    publicToken: 'detailed-token',
    publicTotalToken: 'total-token',
    customerFirstName: 'Ada',
    customerLastName: 'Lovelace',
    customerEmail: 'customer@example.com',
    customerPhone: '+1 305 555 0123',
    customerStreet: '100 Main Street',
    customerCity: 'Miami',
    customerState: 'FL',
    customerPostalCode: '33175',
    customerPriceT: '261.95',
    customerTaxRate: '0.07',
    customerTaxAmount: '18.34',
    customerTotalPayable: '280.29',
    dealerModeSnapshot: 'EXTERNAL',
    status: { name: 'Active' },
    user: {
      dealerMode: 'EXTERNAL',
      role: { name: 'dealer' },
    },
    customerCharges: [],
    installationJob: {
      id: 18,
      status: 'REQUESTED',
      quotes: [
        {
          status: 'DRAFT',
          total: '525.00',
          serviceMinimumsSnapshot: [],
          lines: [
            {
              serviceId: 22,
              origin: 'USER_SELECTED',
              serviceNameSnapshot: 'Concrete Cutting',
              adjustedAmount: '125.00',
            },
          ],
        },
      ],
      permit: {
        permitFeeSnapshot: '1000.00',
        cityFee: null,
      },
    },
    pieces: [
      {
        id: 77,
        mark: 'F1',
        qty: 1,
        width: '35',
        height: '62',
        heightLeft: null,
        heightRight: null,
        legHeight: null,
        doorWidth: null,
        leftSideliteWidth: null,
        rightSideliteWidth: null,
        leftPanels: null,
        rightPanels: null,
        panelCount: null,
        horizontalHeights: null,
        idProd: 1,
        idBrand: 1,
        idSyst: 1,
        idConf: 1,
        idFC: 1,
        idCryst: 1,
        idTint: 1,
        idCoat: 1,
        idPrivacy: null,
        screen: true,
        dpPosPsf: '75',
        dpNegPsf: '-90',
        customerPrice: '261.95',
        customerSubtotal: '261.95',
        prod: { name: 'Single Hung' },
        bran: { name: 'Eco Windows' },
        syst: { name: 'Series 100' },
        conf: { conf: 'Equal Lites' },
        fColor: { color: 'Bronze' },
        cryst: { glass: '3/16 + 3/16' },
        tin: { color: 'Clear' },
        coat: { name: 'None' },
        privacyOption: null,
        activeOption: null,
        preparationOption: null,
        sillOption: null,
        reinforcementOption: null,
        pieceMuntin: null,
      },
    ],
  };
}

function buildService(estimate = sharedEstimateFixture()) {
  const prisma = {
    estimate: {
      findFirst: jest.fn().mockResolvedValue(estimate),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    branding: {
      findFirst: jest.fn().mockResolvedValue({ name: 'Dealer Windows' }),
    },
    sysConf: {
      findMany: jest.fn().mockResolvedValue([
        {
          idSystem: 1,
          idConfig: 1,
          dimensionMode: 'STANDARD',
        },
      ]),
    },
    brandCoating: {
      findMany: jest.fn().mockResolvedValue([
        {
          idBrand: 1,
          idCoating: 1,
          surchargeEnabled: false,
        },
      ]),
    },
    brandPrivacy: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    notification: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const notifications = {
    createAndSend: jest.fn().mockResolvedValue(undefined),
  };
  const customerCharges = new EstimateCustomerChargesService(prisma as any);

  return {
    prisma,
    notifications,
    service: new EstimatePublicShareService(
      prisma as any,
      notifications as any,
      customerCharges,
    ),
  };
}

describe('EstimatePublicShareService customer pricing modes', () => {
  it('uses the discounted taxable subtotal in both detailed and total-only public quotes', async () => {
    const estimate = sharedEstimateFixture();
    estimate.dealerModeSnapshot = estimate.user.dealerMode = 'INTERNAL';
    Object.assign(estimate, {
      customerPriceT: '100.33', customerTaxAmount: '7.02', customerTotalPayable: '107.35',
      installationJob: null, manualDiscount: { scope: 'MATERIAL', type: 'AMOUNT', value: '20' },
    });
    const { service } = buildService(estimate);
    const detailed: any = await service.findPublicEstimateByToken('detailed-token');
    expect(detailed.manualDiscountSummary).toMatchObject({
      discount: '20.00', material: { subtotal: '80.33', tax: '5.62', total: '85.95' },
    });
    const total: any = await service.findPublicEstimateByToken('total-token');
    expect(total.publicProjectTotal).toBe(85.95);
    expect(total.manualDiscountSummary).toBeUndefined();
  });
  it('shares internal-dealer net project totals and hides the breakdown in total-only mode', async () => {
    const estimate = sharedEstimateFixture();
    estimate.dealerModeSnapshot = estimate.user.dealerMode = 'INTERNAL';
    Object.assign(estimate, { manualDiscount: { scope: 'PROJECT', type: 'PERCENTAGE', value: '10' } });
    const { service } = buildService(estimate);
    const detailed: any = await service.findPublicEstimateByToken('detailed-token');
    expect(detailed.manualDiscountSummary.discount).toBe('180.53');
    expect(detailed.manualDiscountSummary.projectTotal).toBe('1624.76');
    expect(detailed.manualDiscountSummary.material.total).toBe('252.26');
    const total: any = await service.findPublicEstimateByToken('total-token');
    expect(total.manualDiscountSummary).toBeUndefined();
    expect(total.publicProjectTotal).toBe(1624.76);
  });
  it('never exposes an external dealer manual discount in public responses', async () => {
    const estimate = sharedEstimateFixture();
    Object.assign(estimate, { manualDiscount: { scope: 'MATERIAL', type: 'PERCENTAGE', value: '10', lockedAt: '2026-09-07T12:00:00Z' } });
    const { service } = buildService(estimate);
    for (const token of ['detailed-token', 'total-token']) {
      const response = JSON.parse(JSON.stringify(await service.findPublicEstimateByToken(token)));
      expect(response).not.toHaveProperty('manualDiscount');
      expect(response).not.toHaveProperty('manualDiscountSummary');
      expect(response.termsPreservedAfterPayment).toBe(true);
      if (token === 'detailed-token') expect(response.customerTotalPayable).toBe('280.29');
      else expect(response.publicProjectTotal).toBe(1805.29);
    }
  });

  it('keeps customer promotion details for an internal dealer and hides item prices in total-only mode', async () => {
    const estimate = sharedEstimateFixture();
    estimate.dealerModeSnapshot = 'INTERNAL';
    estimate.user.dealerMode = 'INTERNAL';
    Object.assign(estimate.pieces[0], {
      regularPrice: '200.00',
      regularCustomerPrice: '300.00',
      promotionSnapshot: { id: 1, percent: '20' },
    });
    const { service } = buildService(estimate);

    const detailed = await service.findPublicEstimateByToken('detailed-token');
    expect(detailed.pieces[0].regularCustomerPrice).toBe('300.00');
    expect(detailed.pieces[0]).not.toHaveProperty('regularPrice');
    expect(detailed.pieces[0]).not.toHaveProperty('promotionSnapshot');

    const totalOnly = await service.findPublicEstimateByToken('total-token');
    expect(JSON.parse(JSON.stringify(totalOnly)).pieces[0]).not.toHaveProperty(
      'regularCustomerPrice',
    );
    expect(totalOnly.pieces[0]).not.toHaveProperty('regularPrice');

    Object.assign(estimate.pieces[0], { promotionSnapshot: null });
    const ordinary = await service.findPublicEstimateByToken('detailed-token');
    expect(ordinary.pieces[0].regularCustomerPrice).toBeUndefined();
  });

  it.each([false, true])(
    'keeps an external dealer promotion private in both public links (paid: %s)',
    async (paid) => {
      const estimate = sharedEstimateFixture();
      const expiresAt = new Date('2026-09-13T23:19:00.000Z');
      Object.assign(estimate, {
        expiresAt,
        promotionExpiresAt: expiresAt,
        promotionLockedAt: paid ? new Date('2026-09-07T12:00:00.000Z') : null,
        originalCustomerPriceT: '300.00',
        customerDiscountAmount: '38.05',
        originalPriceT: '200.00',
        discountAmount: '50.00',
      });
      Object.assign(estimate.pieces[0], {
        regularPrice: '200.00',
        regularCustomerPrice: '300.00',
        rate: '118.74',
        markup: '0.15',
        dealerMarkup: '0.50',
        promotionSnapshot: {
          id: 1, percent: '26.07', name: 'Private dealer offer',
          automaticDealerAdjustment: true,
          dealerPriceBasis: { regularPrice: '200.00', promotionalPrice: '150.00' },
        },
      });
      const before = JSON.stringify(estimate);
      const { service } = buildService(estimate);

      for (const token of ['detailed-token', 'total-token']) {
        const response = await service.findPublicEstimateByToken(token);
        const json = JSON.parse(JSON.stringify(response));
        expect(json.customerPromotionsVisible).toBe(false);
        expect(json.termsPreservedAfterPayment).toBe(paid);
        expect(json.expiresAt).toBe(expiresAt.toISOString());
        for (const field of [
          'promotionExpiresAt', 'promotionLockedAt', 'customerDiscountAmount',
          'originalCustomerPriceT', 'discountAmount', 'originalPriceT',
        ]) expect(json).not.toHaveProperty(field);
        for (const field of [
          'regularPrice', 'regularCustomerPrice', 'promotionSnapshot',
          'rate', 'markup', 'dealerMarkup',
        ]) expect(json.pieces[0]).not.toHaveProperty(field);
        expect(JSON.stringify(json)).not.toContain('Private dealer offer');
        if (token === 'detailed-token') {
          expect(json.pieces[0].customerPrice).toBe('261.95');
          expect(json.pieces[0].customerSubtotal).toBe('261.95');
          expect(json.customerPriceT).toBe('261.95');
          expect(json.customerTaxAmount).toBe('18.34');
          expect(json.customerTotalPayable).toBe('280.29');
        } else {
          expect(json.pieces[0].customerPrice).toBe(0);
          expect(json.publicProjectTotal).toBeGreaterThanOrEqual(280.29);
        }
      }
      expect(JSON.stringify(estimate)).toBe(before);
    },
  );

  it('returns the detailed customer token with customer prices intact', async () => {
    const { service } = buildService();

    const result = await service.findPublicEstimateByToken('detailed-token');

    expect(result.publicPricingMode).toBe('detailed');
    expect(result.customerTotalPayable).toBe('280.29');
    expect(result.pieces[0].customerPrice).toBe('261.95');
    expect(result.pieces[0].diagramMetadata).toEqual({
      dimensionMode: 'STANDARD',
      hasCoating: false,
      hasPrivacy: false,
    });
    expect(result.installationSummary?.additionalServices[0].amount).toBe(
      '0.00',
    );
    expect(result.customerChargesSummary?.systemTotal).toBe('0.00');
    expect(result.customerChargesSummary?.dealerCreatedTotal).toBe('0.00');
    expect(result.customerChargesSummary?.lines[0]).toEqual(
      expect.objectContaining({
        origin: 'DEALER',
        source: 'CUSTOM',
        systemAmount: null,
        customerAmount: '400.00',
        pricingMode: null,
        pricingValue: null,
      }),
    );
  });

  it('uses the external dealer customer prices without exposing company installation cost', async () => {
    const estimate = sharedEstimateFixture();
    estimate.customerCharges = [
      {
        id: 1,
        origin: 'SYSTEM',
        source: 'INSTALLATION',
        sourceKey: 'INSTALLATION',
        sourceRefId: null,
        description: 'Installation',
        pricingMode: 'PERCENTAGE',
        pricingValue: '25.0000',
        systemAmountSnapshot: '400.00',
        sortOrder: 10,
      },
      {
        id: 2,
        origin: 'DEALER',
        source: 'CUSTOM',
        sourceKey: null,
        sourceRefId: null,
        description: 'Remove shutters',
        pricingMode: 'FINAL',
        pricingValue: '250.0000',
        systemAmountSnapshot: null,
        sortOrder: 1000,
      },
    ] as any;
    const { service } = buildService(estimate);

    const result = await service.findPublicEstimateByToken('detailed-token');

    expect(result.customerChargesSummary?.customerTotal).toBe('1875.00');
    expect(result.customerChargesSummary?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: 'Installation',
          customerAmount: '500.00',
          systemAmount: null,
        }),
        expect.objectContaining({
          description: 'Remove shutters',
          customerAmount: '250.00',
          systemAmount: null,
        }),
      ]),
    );
    expect(result.installationSummary).toEqual(
      expect.objectContaining({
        installationAmount: '0.00',
        installationTotal: '0.00',
        permitFee: '0.00',
      }),
    );
    expect(result.installationSummary?.additionalServices[0].amount).toBe(
      '0.00',
    );
  });

  it('omits unused system charges from the customer link and its pending total', async () => {
    const estimate = sharedEstimateFixture();
    estimate.customerCharges = [
      {
        id: 3,
        origin: 'SYSTEM',
        source: 'CITY_FEE',
        sourceKey: 'CITY_FEE',
        sourceRefId: null,
        description: 'City Fee',
        pricingMode: 'SAME',
        pricingValue: '0.0000',
        usedInCustomerQuote: false,
        systemAmountSnapshot: null,
        sortOrder: 910,
      },
    ] as any;
    const { service } = buildService(estimate);

    const result = await service.findPublicEstimateByToken('detailed-token');

    expect(result.customerChargesSummary?.customerTotal).toBe('1525.00');
    expect(result.customerChargesSummary?.customerTotalIncomplete).toBe(false);
    expect(
      result.customerChargesSummary?.lines.some(
        (line: any) => line.description === 'City Fee',
      ),
    ).toBe(false);
  });

  it('returns one project total and removes every component price for the total token', async () => {
    const { service } = buildService();

    const result = await service.findPublicEstimateByToken('total-token');

    expect(result.publicPricingMode).toBe('total');
    expect(result.publicProjectTotal).toBe(1805.29);
    expect(result.publicProjectTotalIncomplete).toBe(true);
    expect(result.customerPriceT).toBe(0);
    expect(result.customerTaxAmount).toBe(0);
    expect(result.customerTotalPayable).toBe(0);
    expect(result.pieces[0].customerPrice).toBe(0);
    expect(result.pieces[0].customerSubtotal).toBe(0);
    expect(result.installationSummary?.installationAmount).toBe('0.00');
    expect(result.installationSummary?.installationTotal).toBe('0.00');
    expect(result.installationSummary?.additionalServices[0]).toEqual(
      expect.objectContaining({
        name: 'Concrete Cutting',
        amount: '0.00',
      }),
    );
    expect(result).not.toHaveProperty('priceT');
    expect(result.pieces[0]).not.toHaveProperty('price');
    expect(result.pieces[0]).not.toHaveProperty('rate');
  });

  it('creates an independent total-only token', async () => {
    const { prisma, service } = buildService();
    prisma.estimate.findUnique.mockResolvedValue({
      id: 9,
      idUser: 44,
      publicToken: 'detailed-token',
      publicTotalToken: null,
      publicTokenEnabled: true,
      dealerModeSnapshot: 'EXTERNAL',
      order: null,
      payments: [],
      status: { name: 'Active' },
      user: {
        dealerMode: 'EXTERNAL',
        role: { name: 'dealer' },
      },
    });
    prisma.estimate.update.mockImplementation(async ({ data }: any) => ({
      publicToken: 'detailed-token',
      publicTotalToken: data.publicTotalToken,
      publicTokenEnabled: data.publicTokenEnabled,
    }));

    const result = await service.getOrCreatePublicLinkToken(
      9,
      { id: 44, role: { name: 'dealer' } } as any,
      'total',
    );

    expect(result.pricingMode).toBe('total');
    expect(result.token).toMatch(/^total_[0-9a-f-]{36}$/);
    expect(result.token).not.toBe('detailed-token');
  });

  it('updates an active estimate to the dealer current mode before returning its token', async () => {
    const { prisma, service } = buildService();
    prisma.estimate.findUnique.mockResolvedValue({
      id: 9,
      idUser: 44,
      publicToken: 'detailed-token',
      publicTotalToken: null,
      publicTokenEnabled: true,
      dealerModeSnapshot: 'EXTERNAL',
      order: null,
      payments: [],
      status: { name: 'Active' },
      user: {
        dealerMode: 'INTERNAL',
        role: { name: 'dealer' },
      },
    });
    prisma.estimate.update.mockResolvedValue({});

    const result = await service.getOrCreatePublicLinkToken(
      9,
      { id: 44, role: { name: 'dealer' } } as any,
      'detailed',
    );

    expect(prisma.estimate.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: {
        dealerModeSnapshot: 'INTERNAL',
      },
    });
    expect(result).toEqual({
      token: 'detailed-token',
      enabled: true,
      pricingMode: 'detailed',
    });
  });
});
