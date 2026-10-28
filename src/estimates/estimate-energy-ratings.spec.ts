import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { EstimatesService } from './estimates.service';
import { buildEnergyPersistence } from '@/energy-ratings/energy-rating-lookup';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import { resolvePieceDesign } from '@/pieces/piece-design';

const selection = {
  idBrand: 3,
  idProd: 2,
  idSyst: 10,
  idConf: 20,
  idCryst: 5,
  idTint: 1,
  idCoat: 2,
  idPrivacy: 1,
};
function rating(id = 100) {
  return {
    id,
    idSystem: 10,
    idCrystal: 5,
    idConfig: null,
    appliesToAllConfigs: true,
    units: 'U_FACTOR_IP',
    uFactor: new Prisma.Decimal('1.062'),
    shgc: new Prisma.Decimal('0.278'),
    vlt: new Prisma.Decimal('0.501'),
    sourceFile: 'NFRC.xlsx',
    sourceSheet: 'NFRC PLAN',
    sourceRow: 93,
    sourceVersion: '0.9',
    sourceGlassId: 'GL-2',
    composition: 'Verified composition',
  };
}

function fixture() {
  const piece: any = {
    ...selection,
    id: 8,
    idEst: 1,
    idFC: 1,
    mark: 'W1',
    qty: 1,
    width: '40',
    height: '60',
    heightLeft: null,
    heightRight: null,
    legHeight: null,
    dealerMarkup: '0.2',
    price: '100',
    rate: '80',
    customerPrice: '120',
    prod: { id: 2, kind: 'GLAZED_UNIT' },
    energyRatingId: null,
    energySnapshot: null,
  };
  const estimate: any = {
    id: 1,
    number: '190001',
    idUser: 7,
    pieces: [piece],
    status: { name: 'Active' },
    payments: [],
    materialRevisions: [],
    order: null,
    ownerMarkupSnapshot: '.25',
    taxRate: '.07',
    customerTaxRate: '.07',
    totalPayable: '107',
    customerTotalPayable: '128.40',
  };
  const actor: any = { id: 7, markupOverride: null, role: { name: 'dealer', markup: new Prisma.Decimal('.25') } };
  const tx: any = {
    $queryRaw: jest.fn(async () => [{ id: 1 }]),
    estimate: { findUnique: jest.fn(async () => estimate), update: jest.fn() },
    estimateAgreement: { findMany: jest.fn(async () => []) },
    user: { findUnique: jest.fn(async () => actor) },
    product: { findUnique: jest.fn(async () => ({ kind: 'GLAZED_UNIT' })) },
    energyRating: { findMany: jest.fn(async () => [rating()]) },
    piece: {
      findFirst: jest.fn(async () => piece),
      update: jest.fn(async ({ data }) => {
        Object.assign(piece, data);
        return piece;
      }),
    },
  };
  tx.$transaction = jest.fn(async (callback) => callback(tx));
  const calculator = {
    createCalculationCache: jest.fn(() => ({})),
    calculatePieceMetrics: jest.fn(async (input) => ({
      ...input,
      rate: new Decimal(80),
      price: new Decimal(100),
      regularPrice: new Decimal(100),
      customerPrice: new Decimal(120),
      regularCustomerPrice: new Decimal(120),
      subtotal: new Decimal(100),
      customerSubtotal: new Decimal(120),
      markup: new Decimal('.25'),
      dealerMarkupDecimal: new Decimal('.2'),
      netProfit: new Decimal(20),
      netProfitD: new Decimal(20),
      dpPosPsf: new Decimal(30),
      dpNegPsf: new Decimal(30),
    })),
  };
  const workflow = {
    assertEstimateEditAllowed: jest.fn(),
    refreshUnpaidDealerMeasurements: jest.fn(),
  };
  const logs = { log: jest.fn() };
  const service = new EstimatesService(
    tx,
    logs as any,
    {} as any,
    {} as any,
    calculator as any,
    {} as any,
    workflow as any,
    {} as any,
    { eligible: jest.fn(async () => []) } as any,
    {} as any,
  );
  jest
    .spyOn(service as any, 'getEstimateWithRelationsInTransaction')
    .mockImplementation(async () => ({
      ...estimate,
      pieces: estimate.pieces.map((row) => ({ ...row })),
    }));
  const totals = jest
    .spyOn(service as any, 'updateEstimateTotalsFromPersistedPieces')
    .mockResolvedValue(undefined);
  const muntins = jest
    .spyOn(service as any, 'replacePieceMuntin')
    .mockResolvedValue(undefined);
  return {
    service,
    tx,
    piece,
    estimate,
    actor,
    calculator,
    workflow,
    logs,
    totals,
    muntins,
  };
}

describe('estimate energy integration', () => {
  it('returns energy with Calculate before saving a new piece, preserving prices and DP', async () => {
    const f = fixture();
    const before = JSON.stringify(f.piece);
    const result = await f.service.calculateAndReturnPieceMetrics({ ...f.piece } as any, 7, 1);
    expect(result.energyRatingId).toBe(100);
    expect(result.energySnapshot).toMatchObject({
      status: 'AVAILABLE', uFactor: '1.062', shgc: '0.278', vlt: '0.501',
    });
    expect(result.energySnapshot).not.toHaveProperty('units');
    expect(result.price.toString()).toBe('100');
    expect(result.customerPrice.toString()).toBe('120');
    expect(result.dpPosPsf.toString()).toBe('30');
    expect(result.dpNegPsf.toString()).toBe('30');
    expect(JSON.stringify(f.piece)).toBe(before);
    expect(f.tx.piece.update).not.toHaveBeenCalled();
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
    expect(f.logs.log).not.toHaveBeenCalled();
  });

  it('previews the saved energy values when only dimensions change', async () => {
    const f = fixture();
    Object.assign(f.piece, await buildEnergyPersistence(f.tx, selection));
    const previous = f.piece.energySnapshot;
    f.tx.energyRating.findMany.mockClear();
    f.tx.energyRating.findMany.mockResolvedValue([{ ...rating(101), uFactor: new Prisma.Decimal('.7') }]);
    const result = await f.service.calculateAndReturnPieceMetrics({ ...f.piece, width: '45' } as any, 7, 1, 8);
    expect(result.energySnapshot).toEqual(previous);
    expect(f.tx.energyRating.findMany).not.toHaveBeenCalled();
    expect(f.tx.piece.update).not.toHaveBeenCalled();
  });

  it('looks up a changed glass selection during Calculate without changing the saved piece', async () => {
    const f = fixture();
    Object.assign(f.piece, await buildEnergyPersistence(f.tx, selection));
    const previous = f.piece.energySnapshot;
    f.tx.energyRating.findMany.mockClear();
    f.tx.energyRating.findMany.mockResolvedValue([{ ...rating(101), shgc: new Prisma.Decimal('.35') }]);
    const result = await f.service.calculateAndReturnPieceMetrics({ ...f.piece, idCoat: 3 } as any, 7, 1, 8);
    expect(result.energySnapshot).toMatchObject({ ratingId: 101, shgc: '0.35', selection: { idCoat: 3 } });
    expect(f.tx.energyRating.findMany).toHaveBeenCalledTimes(1);
    expect(f.piece.energySnapshot).toEqual(previous);
    expect(f.tx.piece.update).not.toHaveBeenCalled();
  });

  it('keeps unavailable preview values empty and linear materials not applicable', async () => {
    const f = fixture();
    f.tx.energyRating.findMany.mockResolvedValue([]);
    const missing = await f.service.calculateAndReturnPieceMetrics({ ...f.piece } as any, 7, 1);
    expect(missing.energySnapshot).toMatchObject({ status: 'UNAVAILABLE', uFactor: null, shgc: null, vlt: null });
    f.tx.product.findUnique.mockResolvedValue({ kind: 'LINEAR_MATERIAL' });
    f.tx.energyRating.findMany.mockClear();
    const linear = await f.service.calculateAndReturnPieceMetrics({ ...f.piece } as any, 7, 1);
    expect(linear.energySnapshot.status).toBe('NOT_APPLICABLE');
    expect(f.tx.energyRating.findMany).not.toHaveBeenCalled();
    expect(f.tx.piece.update).not.toHaveBeenCalled();
  });

  it('returns null for an unchanged legacy piece and checks piece ownership before preview', async () => {
    const f = fixture();
    const legacy = await f.service.calculateAndReturnPieceMetrics({ ...f.piece } as any, 7, 1, 8);
    expect(legacy.energySnapshot).toBeNull();
    expect(f.tx.energyRating.findMany).not.toHaveBeenCalled();
    expect(f.tx.piece.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 8, idEst: 1 } }));
    f.tx.piece.findFirst.mockResolvedValue(null);
    await expect(f.service.calculateAndReturnPieceMetrics({ ...f.piece } as any, 7, 1, 99)).rejects.toThrow(NotFoundException);
    expect(f.tx.piece.update).not.toHaveBeenCalled();
  });

  it('explicit refresh changes only energy fields, without recalculating prices or diagrams', async () => {
    const f = fixture();
    await f.service.refreshEnergyRatings(1, 7);
    const data = f.tx.piece.update.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual([
      'energyRatingId',
      'energySnapshot',
    ]);
    expect(data.energySnapshot).toMatchObject({
      status: 'AVAILABLE',
      uFactor: '1.062',
    });
    expect(f.piece.price).toBe('100');
    expect(f.estimate.totalPayable).toBe('107');
    expect(f.calculator.calculatePieceMetrics).not.toHaveBeenCalled();
    expect(f.totals).not.toHaveBeenCalled();
    expect(f.muntins).not.toHaveBeenCalled();
    expect(f.workflow.refreshUnpaidDealerMeasurements).not.toHaveBeenCalled();
    expect(f.logs.log).toHaveBeenCalledWith(
      expect.objectContaining({
        before: expect.objectContaining({
          pieces: [expect.objectContaining({ energySnapshot: null })],
        }),
        after: expect.objectContaining({
          pieces: [expect.objectContaining({ energyRatingId: 100 })],
        }),
      }),
    );
  });

  it('rejects a different account before any energy write', async () => {
    const f = fixture();
    f.actor.id = 99;
    f.actor.role.name = 'client';
    await expect(f.service.refreshEnergyRatings(1, 99)).rejects.toThrow(
      NotFoundException,
    );
    expect(f.tx.energyRating.findMany).not.toHaveBeenCalled();
    expect(f.tx.piece.update).not.toHaveBeenCalled();
  });

  it('refreshes energy with an existing payment plan without synchronizing financial schedules', async () => {
    const f = fixture();
    const paymentPlanSnapshot = {
      version: 1,
      name: 'Half now',
      definition: {
        withoutInstallation: [
          { milestone: 'ORDER', basis: 'MATERIAL', percent: 50 },
          { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 },
        ],
      },
    };
    f.estimate.paymentPlanSnapshot = paymentPlanSnapshot;
    f.tx.$queryRaw.mockResolvedValue([{ id: 1, paymentPlanSnapshot }]);
    // No payment/schedule mutation delegates exist in this fixture on purpose.
    await f.service.refreshEnergyRatings(1, 7);
    expect(f.piece.energySnapshot).toMatchObject({ status: 'AVAILABLE' });
    expect(f.estimate.paymentPlanSnapshot).toEqual(paymentPlanSnapshot);
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
    expect(f.calculator.calculatePieceMetrics).not.toHaveBeenCalled();
    expect(f.totals).not.toHaveBeenCalled();
    expect(f.workflow.refreshUnpaidDealerMeasurements).not.toHaveBeenCalled();
    expect(f.tx.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 30000,
    });
  });

  it.each(['order', 'paid', 'status'])(
    'rejects energy refresh for a locked estimate (%s)',
    async (lock) => {
      const f = fixture();
      if (lock === 'order') f.estimate.order = { id: 2 };
      if (lock === 'paid')
        f.estimate.payments = [{ type: 'MATERIAL', status: 'PAID' }];
      if (lock === 'status') f.estimate.status.name = 'Ordered';
      await expect(f.service.refreshEnergyRatings(1, 7)).rejects.toThrow(
        BadRequestException,
      );
      expect(f.tx.energyRating.findMany).not.toHaveBeenCalled();
      expect(f.tx.piece.update).not.toHaveBeenCalled();
    },
  );

  it('keeps a frozen rating during a normal piece update and resolves a changed coating', async () => {
    const f = fixture();
    Object.assign(f.piece, await buildEnergyPersistence(f.tx, selection));
    const original = f.piece.energySnapshot;
    f.tx.energyRating.findMany.mockClear();
    await f.service.updatePieceInEstimate(
      1,
      8,
      { ...f.piece, width: '45' } as any,
      7,
    );
    expect(f.piece.energySnapshot).toEqual(original);
    expect(f.tx.energyRating.findMany).not.toHaveBeenCalled();
    f.tx.energyRating.findMany.mockResolvedValue([rating(101)]);
    await f.service.updatePieceInEstimate(
      1,
      8,
      { ...f.piece, idCoat: 3 } as any,
      7,
    );
    expect(f.piece.energySnapshot).toMatchObject({
      ratingId: 101,
      selection: { idCoat: 3 },
    });
  });

  it('keeps legacy energy empty on a frame change but resolves bulk tint changes', async () => {
    const f = fixture();
    await f.service.applyBulkPieceAttributeToEstimate(1, { idFC: 2 }, 7);
    expect(f.piece.energySnapshot).toBe(Prisma.DbNull);
    expect(f.tx.energyRating.findMany).not.toHaveBeenCalled();
    await f.service.applyBulkPieceAttributeToEstimate(1, { idTint: 4 }, 7);
    expect(f.piece.energySnapshot).toMatchObject({
      status: 'AVAILABLE',
      selection: { idTint: 4 },
    });
    expect(f.tx.energyRating.findMany).toHaveBeenCalledTimes(1);
  });

  it('persists the linked design frame when a bulk frame change targets the estimate', async () => {
    const f = fixture();
    Object.assign(f.piece, { idFC: 7, idDesign: 11, idDesignColor: 12, frameColorBeforeDesignId: 1,
      designSnapshot: { version: 1, systemId: 10,
        design: { id: 11, name: 'Solid', imageUrl: null },
        color: { id: 12, name: 'Oak', hexCode: '#995522', idFrameColor: 7 } } });
    f.tx.systemFrameColor = { findUnique: jest.fn(async () => ({ frameColor: { isActive: true } })) };
    f.tx.frameColor = { findUnique: jest.fn(async () => ({ id: 1 })) };
    const calculate = f.calculator.calculatePieceMetrics.getMockImplementation()!;
    f.calculator.calculatePieceMetrics.mockImplementation(async (input) => ({ ...await calculate(input), ...await resolvePieceDesign(f.tx, input) }));
    await f.service.applyBulkPieceAttributeToEstimate(1, { idFC: 2 }, 7);
    expect(f.piece.idFC).toBe(7);
    expect(f.piece.frameColorBeforeDesignId).toBe(1);
    expect(f.piece.price.toString()).toBe('100');
    expect(f.tx.piece.update.mock.calls[0][0].data).toMatchObject({ idFC: 7, frameColorBeforeDesignId: 1,
      designSnapshot: { color: { idFrameColor: 7 } } });
  });

  it('general markup updates leave old energy values and uncaptured legacy pieces untouched', async () => {
    const f = fixture();
    await f.service.applyGeneralDealerMarkupToEstimate(1, 30, 7);
    expect(f.piece.energySnapshot).toBeNull();
    expect(f.tx.energyRating.findMany).not.toHaveBeenCalled();
    expect(f.tx.piece.update.mock.calls[0][0].data).not.toHaveProperty(
      'energySnapshot',
    );
  });

  it('returns remembered frame on reopen and clears it when saving a design removal', async () => {
    const f = fixture();
    Object.assign(f.piece, { idFC: 7, idDesign: 11, idDesignColor: 12, frameColorBeforeDesignId: 1,
      designSnapshot: { version: 1, systemId: 10,
        design: { id: 11, name: 'Solid', imageUrl: null },
        color: { id: 12, name: 'Oak', hexCode: '#995522', idFrameColor: 7 } } });
    f.tx.systemFrameColor = { findUnique: jest.fn(async () => ({ frameColor: { isActive: true } })) };
    f.tx.frameColor = { findUnique: jest.fn(async () => ({ id: 1 })) };
    const calculate = f.calculator.calculatePieceMetrics.getMockImplementation()!;
    f.calculator.calculatePieceMetrics.mockImplementation(async (input) => ({ ...await calculate(input), ...await resolvePieceDesign(f.tx, input) }));
    const { frameColorBeforeDesignId, ...legacyInput } = f.piece;
    const preview = await f.service.calculateAndReturnPieceMetrics({ ...legacyInput } as any, 7, 1, 8);
    expect(preview).toMatchObject({ idFC: 7, frameColorBeforeDesignId: 1 });
    expect(f.tx.piece.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ idFC: true, frameColorBeforeDesignId: true }),
    }));
    await f.service.updatePieceInEstimate(1, 8, { ...legacyInput, idFC: 1, idDesign: null, idDesignColor: null } as any, 7);
    expect(f.piece).toMatchObject({ idFC: 1, idDesign: null, idDesignColor: null, frameColorBeforeDesignId: null });
  });

  it('keeps remembered frame in duplication and installation revision input/output adapters', () => {
    const f = fixture();
    Object.assign(f.piece, { idDesign: 11, idDesignColor: 12, frameColorBeforeDesignId: 1 });
    const workflow: any = Object.create(InstallationWorkflowService.prototype);
    const clone = (f.service as any).buildPieceDtoFromPersistedPiece(f.piece, 20, false);
    expect(clone.frameColorBeforeDesignId).toBe(1);
    expect(workflow.pieceInputFromPersisted(f.piece).frameColorBeforeDesignId).toBe(1);
    expect(workflow.additionPieceInput(clone).frameColorBeforeDesignId).toBe(1);
  });

  it('revision saves preserve unchanged glass ratings and resolve normalized changed IDs', async () => {
    const f = fixture();
    Object.assign(f.piece, await buildEnergyPersistence(f.tx, selection));
    const original = f.piece.energySnapshot;
    f.tx.energyRating.findMany.mockClear();
    f.tx.piece.findUniqueOrThrow = jest.fn(async () => f.piece);
    const workflow: any = Object.create(InstallationWorkflowService.prototype);
    workflow.pieceInputFromPersisted = jest.fn(() => ({ muntin: undefined }));
    const pricing = {
      rate: '80',
      price: '100',
      customerPrice: '120',
      netProfit: '20',
      markup: '.25',
      dealerMarkupDecimal: '.2',
      dpPosPsf: '30',
      dpNegPsf: '30',
      highBottomPercent: null,
    };
    await workflow.saveRevisionPiece(
      1,
      { ...selection, idFC: 1, width: '45' },
      pricing,
      1,
      'W1',
      f.tx,
      f.piece,
    );
    expect(f.piece.energySnapshot).toEqual(original);
    expect(f.tx.energyRating.findMany).not.toHaveBeenCalled();
    const changedInput = Object.fromEntries(
      Object.entries({ ...selection, idCoat: 3, idFC: 1 }).map(
        ([key, value]) => [key, String(value)],
      ),
    );
    await workflow.saveRevisionPiece(
      1,
      changedInput,
      pricing,
      1,
      'W1',
      f.tx,
      f.piece,
    );
    expect(f.piece.energySnapshot).toMatchObject({
      status: 'AVAILABLE',
      selection: { idCoat: 3 },
    });
    expect(f.tx.energyRating.findMany).toHaveBeenCalledTimes(1);
    const approvedEnergy = {
      energyRatingId: f.piece.energyRatingId,
      energySnapshot: f.piece.energySnapshot,
    };
    f.tx.energyRating.findMany.mockClear();
    f.tx.energyRating.findMany.mockRejectedValue(
      new Error('Approved energy must not be looked up again'),
    );
    await workflow.saveRevisionPiece(
      1,
      changedInput,
      pricing,
      1,
      'W1',
      f.tx,
      f.piece,
      approvedEnergy,
    );
    expect(f.piece.energySnapshot).toEqual(approvedEnergy.energySnapshot);
    expect(f.tx.energyRating.findMany).not.toHaveBeenCalled();
  });

  it('drops a deleted remembered color when an older revision is finally saved', async () => {
    const f = fixture();
    f.tx.frameColor = { findUnique: jest.fn(async () => null) };
    f.tx.piece.findUniqueOrThrow = jest.fn(async () => f.piece);
    const workflow: any = Object.create(InstallationWorkflowService.prototype);
    workflow.pieceInputFromPersisted = jest.fn(() => ({ muntin: undefined }));
    await workflow.saveRevisionPiece(1,
      { ...selection, idFC: 7, idDesign: 11, idDesignColor: 12, frameColorBeforeDesignId: 99 },
      { rate: '80', price: '100', customerPrice: '120', netProfit: '20', markup: '.25',
        dealerMarkupDecimal: '.2', dpPosPsf: '30', dpNegPsf: '30', highBottomPercent: null },
      1, 'W1', f.tx, f.piece);
    expect(f.piece).toMatchObject({ idFC: 7, idDesign: 11, idDesignColor: 12, frameColorBeforeDesignId: null });
    expect(f.piece.price.toString()).toBe('100');
  });
});
