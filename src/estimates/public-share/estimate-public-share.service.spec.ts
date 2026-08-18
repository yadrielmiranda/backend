import { EstimatePublicShareService } from './estimate-public-share.service';

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
    status: { name: 'Active' },
    user: { role: { name: 'dealer' } },
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
    notification: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const notifications = {
    createAndSend: jest.fn().mockResolvedValue(undefined),
  };

  return {
    prisma,
    notifications,
    service: new EstimatePublicShareService(
      prisma as any,
      notifications as any,
    ),
  };
}

describe('EstimatePublicShareService customer pricing modes', () => {
  it('returns the detailed customer token with customer prices intact', async () => {
    const { service } = buildService();

    const result = await service.findPublicEstimateByToken('detailed-token');

    expect(result.publicPricingMode).toBe('detailed');
    expect(result.customerTotalPayable).toBe('280.29');
    expect(result.pieces[0].customerPrice).toBe('261.95');
    expect(result.installationSummary?.additionalServices[0].amount).toBe(
      '125.00',
    );
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
      status: { name: 'Active' },
      user: { role: { name: 'dealer' } },
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
});
