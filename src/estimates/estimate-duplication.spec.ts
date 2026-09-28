import { BadRequestException, ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import Decimal from 'decimal.js';
import { EstimatesService } from './estimates.service';
import { EstimatePieceCalculatorService } from './calculation/estimate-piece-calculator.service';
import { EstimateMuntinService } from './muntins/estimate-muntin.service';
import { DuplicateEstimateDto } from './dto/duplicate-estimate.dto';

const dealer: any = { id: 7, role: { name: 'dealer' } };
const address = { street: '123 Main St', city: 'Miami', state: 'FL', postalCode: '33101' };
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

// Doble transaccional con rollback; se usan los mapeos y el cálculo de totales reales.
function fixture() {
  const owner: any = {
    id: 7, isActive: true, isTaxExempt: false, markupOverride: '.25',
    dealerMode: 'EXTERNAL', dealerEarningsPlanId: null, paymentPlanId: null,
    role: { name: 'dealer', markup: '.5', paymentPlanId: null },
  };
  const source: any = {
    id: 1, number: '190910', name: 'Original', idUser: 7,
    status: { id: 2, name: 'Ordered' }, statusId: 2,
    user: owner, units: 2, ownerMarkupSnapshot: '.9', customerTaxRate: '.07',
    taxRate: '.06', totalPayable: '50', customerTotalPayable: '60',
    customerFirstName: 'Ana', customerLastName: 'Diaz', customerEmail: 'ana@example.test',
    customerPhone: '+13055551234', customerStreet: address.street, customerCity: address.city,
    customerState: address.state, customerPostalCode: address.postalCode,
    date: '2025-01-01', expiresAt: '2025-02-01', updatedAt: '2025-01-15',
    publicToken: 'old-public', publicTotalToken: 'old-total', agreementRevision: 8,
    agreements: [{ id: 12, signedAt: '2025-01-15' }], order: { id: 30 },
    payments: [{ id: 40, status: 'PAID', stripeSessionId: 'cs_old' }],
    promotionLockedAt: '2025-01-15', promotionContext: [{ id: 98, percent: '90' }],
    manualDiscount: { scope: 'MATERIAL', type: 'PERCENTAGE', value: '10' },
    paymentPlanSnapshot: { name: 'Old plan', locked: { rows: [] }, adjustments: [] },
    materialRevisions: [], installationJob: null, customerCharges: [],
    pieces: [{
      id: 2, idEst: 1, mark: 'W1', qty: 2, dealerMarkup: '.2',
      idProd: 1, idBrand: 2, idSyst: 3, idConf: 4, idFC: 5, idCryst: 6,
      idTint: 7, idCoat: 8, idPrivacy: 9, screen: true, highBottom: true,
      idActiveOption: 11, idPreparationOption: 12, idSillOption: 13, idReinforcementOption: 14,
      width: '40', height: '60', heightLeft: null, heightRight: null, legHeight: null,
      sashHeight: '25', windowHeight: null, doorWidth: null, doorHeight: null,
      leftSideliteWidth: null, rightSideliteWidth: null, leftPanels: 2, rightPanels: 1,
      panelCount: 3, horizontalHeights: [20, 40], price: '20', rate: '10',
      factoryUnits: [{ id: 99 }], installationMeasurements: [{ id: 100 }],
      pieceMuntin: { id: 4, pieceId: 2, patternId: 4, typeId: 5, panels: [{
        id: 9, pieceMuntinId: 4, panelIndex: 1, panelCode: 'A', panelLabel: 'Upper',
        horizontalLites: 2, verticalLites: 3,
      }] },
    }],
  };
  let created: any[] = [], pieces: any[] = [], muntins: any[] = [], charges: any[] = [];
  const tx: any = {
    $queryRaw: jest.fn(async (sql, ...values) => String(sql).includes('DealerEarningsPlan')
      ? [{ id: 17, name: 'Current earnings', basis: 'EXPECTED_PROFIT', percent: '40', revision: 2, isActive: true }]
      : [{ id: values[0] }]),
    user: { findUniqueOrThrow: jest.fn(async () => owner) },
    estimate: {
      findUnique: jest.fn(async ({ where }) => where.id === 1 ? json(source) : created.find(e => e.id === where.id)),
      create: jest.fn(async ({ data }) => {
        const copy = { ...data, id: 100 + created.length };
        created.push(copy); return copy;
      }),
      update: jest.fn(() => { throw new Error('Unexpected estimate update'); }),
    },
    estimateStatus: { findUnique: jest.fn(async () => ({ id: 1, name: 'Active' })) },
    globalParameter: { findUnique: jest.fn(async ({ where }) => ({ value: where.key === 'SALES_TAX' ? '.08' : 30 })) },
    estimateSequence: { create: jest.fn(async () => ({ id: 500 + created.length })) },
    piece: { create: jest.fn(async ({ data }) => {
      const piece = { ...data, id: 1000 + pieces.length };
      pieces.push(piece); return piece;
    }) },
    pieceMuntin: {
      deleteMany: jest.fn(async ({ where }) => {
        if (where.pieceId === 2) throw new Error('Original muntin touched');
      }),
      create: jest.fn(async ({ data }) => { muntins.push(data); return data; }),
    },
    estimateCustomerCharge: { createMany: jest.fn(async ({ data }) => { charges.push(...data); }) },
  };
  tx.$transaction = jest.fn(async (work) => {
    const saved = [created.length, pieces.length, muntins.length, charges.length];
    try { return await work(tx); }
    catch (error) {
      [created, pieces, muntins, charges].forEach((rows, index) => rows.splice(saved[index]));
      throw error;
    }
  });
  const calculator = new EstimatePieceCalculatorService({} as any, {} as any);
  const calculate = jest.spyOn(calculator, 'calculatePieceMetrics').mockImplementation(async (input, markup, _tx, cache) => {
    const rate = new Decimal(100), price = rate.mul(new Decimal(1).add(markup));
    const dealerMarkupDecimal = new Decimal(input.dealerMarkup ?? 0).div(100);
    const customerPrice = price.mul(new Decimal(1).add(dealerMarkupDecimal));
    return { ...input, rate, price, regularPrice: price, customerPrice, regularCustomerPrice: customerPrice,
      markup, dealerMarkupDecimal, subtotal: price.mul(input.qty), customerSubtotal: customerPrice.mul(input.qty),
      netProfit: price.sub(rate), netProfitD: customerPrice.sub(price).mul(input.qty),
      dpPosPsf: new Decimal(30), dpNegPsf: new Decimal(40), promotionSnapshot: cache?.promotions?.[0] ?? null,
    } as any;
  });
  const workflow = {
    prepareDuplicateInstallation: jest.fn(async () => ({ address, snapshot: { revision: 2 } })),
    duplicateInstallationInTransaction: jest.fn(async () => ({ id: 300 })),
  };
  const logs = { log: jest.fn() };
  const eligible = jest.fn(async () => [] as any[]);
  const service = new EstimatesService(tx, logs as any, {} as any, {} as any, calculator,
    new EstimateMuntinService(), workflow as any, {} as any, { eligible } as any, {} as any);
  const installation = () => source.installationJob = {
    id: 21, status: 'COMPLETED', installationAddress: address, permit: { cityFee: '500' },
    quotes: [{ id: 31, version: 4, status: 'APPROVED', total: '900', lines: [] }],
  };
  return { source, owner, tx, workflow, logs, calculate, eligible, service, installation,
    created: () => created, pieces: () => pieces, muntins: () => muntins, charges: () => charges,
    duplicate: (includeInstallation = false, actor = dealer) => service.duplicateEstimate(1, { name: 'Alternative', includeInstallation }, actor),
  };
}

describe('Independent estimate duplication', () => {
  it('copies configuration into new records, reprices, resets history and leaves the original unchanged', async () => {
    const f = fixture(), original = json(f.source);
    const result = await f.duplicate();
    const copy = f.created()[0], piece = f.pieces()[0];
    expect(result.id).not.toBe(1);
    expect(copy).toMatchObject({ name: 'Alternative', idUser: 7, statusId: 1, units: 2 });
    expect(copy.number).not.toBe(f.source.number);
    expect(copy.totalPayable.toString()).toBe('270');
    expect(copy.customerTotalPayable.toString()).toBe('321');
    expect(copy.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(piece).toMatchObject({ idEst: copy.id, mark: 'W1', qty: 2, idTint: 7, idCoat: 8, screen: true, highBottom: true });
    expect(piece.width.toString()).toBe('40');
    expect(piece.sashHeight.toString()).toBe('25');
    expect(piece.horizontalHeights).toEqual([20, 40]);
    expect(f.calculate.mock.calls[0][0]).toMatchObject({ dealerMarkup: 20, idPrivacy: 9, idReinforcementOption: 14, leftPanels: 2 });
    expect(f.muntins()[0].piece.connect.id).toBe(piece.id);
    expect(f.muntins()[0].panels.create[0]).toEqual({ panelIndex: 1, panelCode: 'A', panelLabel: 'Upper', horizontalLites: 2, verticalLites: 3 });
    for (const key of ['publicToken', 'publicTotalToken', 'agreementRevision', 'agreements', 'payments', 'order', 'manualDiscount', 'promotionLockedAt', 'date', 'createdAt', 'updatedAt']) {
      expect(copy).not.toHaveProperty(key);
    }
    expect(copy.paymentPlanSnapshot).not.toHaveProperty('locked');
    expect(copy.paymentPlanSnapshot).not.toHaveProperty('adjustments');
    expect(piece).not.toHaveProperty('factoryUnits');
    expect(piece).not.toHaveProperty('installationMeasurements');
    expect(json(f.source)).toEqual(original);
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
    expect(f.logs.log).toHaveBeenCalledWith(expect.objectContaining({ entityId: copy.id, userId: 7 }), f.tx);
  });

  it.each(['admin', 'operator'])('uses the original owner and current pricing for %s', async role => {
    const f = fixture();
    await f.duplicate(false, { id: 90, role: { name: role } });
    expect(f.created()[0].idUser).toBe(7);
    expect(f.calculate.mock.calls[0][1].toString()).toBe('0.25');
    expect(f.eligible).toHaveBeenCalledWith(7, f.tx);
  });

  it.each([{ id: 8, role: { name: 'dealer' } }, { id: 7, role: { name: 'technician' } }])('denies unauthorized actors before pricing or writing', async actor => {
    const f = fixture(); f.installation();
    await expect(f.duplicate(true, actor)).rejects.toThrow();
    expect(f.workflow.prepareDuplicateInstallation).not.toHaveBeenCalled();
    expect(f.created()).toHaveLength(0);
  });

  it.each(['Active', 'Expired', 'Canceled', 'Ordered'])('creates an active independent copy from %s', async status => {
    const f = fixture(); f.source.status.name = status;
    await f.duplicate();
    expect(f.created()[0].statusId).toBe(1);
    expect(f.source.status.name).toBe(status);
  });

  it('refreshes tax exemption, earnings and promotion expiration from current settings', async () => {
    const f = fixture();
    f.owner.isTaxExempt = true; f.owner.dealerMode = 'INTERNAL'; f.owner.dealerEarningsPlanId = 17;
    const end = new Date(Date.now() + 86400000);
    f.eligible.mockResolvedValue([{ id: 55, percent: '10', endsAt: end.toISOString() }]);
    await f.duplicate();
    expect(f.created()[0].taxRate.toString()).toBe('0');
    expect(f.created()[0].dealerEarningsPlanSnapshot.planId).toBe(17);
    expect(f.created()[0].promotionContext[0].id).toBe(55);
    expect(f.created()[0].expiresAt.toISOString()).toBe(end.toISOString());
  });

  it('copies only independent custom charges when materials only is selected', async () => {
    const f = fixture(); f.installation();
    f.source.customerCharges = ['CUSTOM', 'INSTALLATION', 'INSTALLATION_SERVICE', 'PERMIT', 'CITY_FEE'].map((source, i) => ({
      id: i + 1, estimateId: 1, source, origin: source === 'CUSTOM' ? 'DEALER' : 'SYSTEM',
      sourceKey: source === 'CUSTOM' ? null : source, pricingMode: 'PERCENTAGE', pricingValue: '20',
      description: source, usedInCustomerQuote: true, sortOrder: i, systemAmountSnapshot: '100',
    }));
    await f.duplicate(false);
    expect(f.workflow.prepareDuplicateInstallation).not.toHaveBeenCalled();
    expect(f.workflow.duplicateInstallationInTransaction).not.toHaveBeenCalled();
    expect(f.charges()).toHaveLength(1);
    expect(f.charges()[0]).toMatchObject({ source: 'CUSTOM', estimateId: 100 });
    expect(f.charges()[0]).not.toHaveProperty('id');
  });

  it('creates installation in the same transaction against the NEW estimate', async () => {
    const f = fixture(); f.installation();
    const before = json(f.source);
    await f.duplicate(true);
    expect(f.workflow.duplicateInstallationInTransaction).toHaveBeenCalledWith(100, expect.objectContaining({ id: 21 }), dealer, expect.any(Object), f.tx);
    expect(json(f.source)).toEqual(before);
  });

  it('does not create a partial copy or silently drop unavailable installation', async () => {
    const f = fixture(); f.installation();
    f.workflow.prepareDuplicateInstallation.mockRejectedValue(new BadRequestException({ code: 'INSTALLATION_OUTSIDE_COVERAGE', message: 'Unavailable' }));
    await expect(f.duplicate(true)).rejects.toThrow('Unavailable');
    expect(f.tx.$transaction).not.toHaveBeenCalled();
    expect(f.created()).toHaveLength(0);
    await f.duplicate(false);
    expect(f.created()).toHaveLength(1);
  });

  it('rolls back all records when installation fails after material creation', async () => {
    const f = fixture(); f.installation();
    const original = json(f.source);
    f.workflow.duplicateInstallationInTransaction.mockRejectedValue(new ConflictException('Installation pricing changed'));
    await expect(f.duplicate(true)).rejects.toThrow('Installation pricing changed');
    expect(f.created()).toHaveLength(0); expect(f.pieces()).toHaveLength(0); expect(f.muntins()).toHaveLength(0);
    expect(f.logs.log).not.toHaveBeenCalled();
    expect(json(f.source)).toEqual(original);
  });

  it('rejects changed installation after external coverage validation', async () => {
    const f = fixture(); f.installation();
    f.workflow.prepareDuplicateInstallation.mockImplementation(async () => {
      f.source.installationJob.installationAddress = { ...address, street: 'Changed street' };
      return { address, snapshot: { revision: 2 } };
    });
    await expect(f.duplicate(true)).rejects.toThrow('installation changed');
    expect(f.created()).toHaveLength(0);
  });

  it('rejects invalid material and does not reuse old prices', async () => {
    const f = fixture();
    f.calculate.mockRejectedValue(new BadRequestException('Product is inactive'));
    await expect(f.duplicate()).rejects.toThrow('Product is inactive');
    expect(f.created()).toHaveLength(0);
  });

  it('requires a real boolean choice in the API', async () => {
    for (const body of [{}, { includeInstallation: 'false' }, { includeInstallation: null }]) {
      expect((await validate(plainToInstance(DuplicateEstimateDto, body))).length).toBeGreaterThan(0);
    }
    expect(await validate(plainToInstance(DuplicateEstimateDto, { includeInstallation: false, name: ' Copy ' }))).toEqual([]);
  });
});
