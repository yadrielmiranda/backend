import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { ROLES_KEY } from '@/auth/roles.decorator';
import type { CreatePieceDto } from '@/pieces/dto/create-piece.dto';
import { InstallationWorkflowController } from './installation-workflow.controller';
import { InstallationWorkflowService } from './installation-workflow.service';

const admin: AuthUser = { id: 1, role: { name: 'admin' } };
const input: CreatePieceDto = {
  mark: ' W1 ',
  idProd: 1,
  idBrand: 1,
  idSyst: 1,
  idConf: 1,
  idFC: 2,
  idCryst: 1,
  idTint: 1,
  idCoat: 1,
  idPrivacy: 1,
  width: '54',
  height: '39',
  qty: 4,
  dealerMarkup: 20,
  screen: true,
};

function fixture() {
  const promotion = {
    id: 1,
    version: 1,
    name: 'Preserved promotion',
    percent: '35',
    startsAt: '2020-01-01T00:00:00Z',
    endsAt: '2020-02-01T00:00:00Z',
    brandId: null,
    productId: null,
    systemId: null,
  };
  const piece: any = {
    id: 321,
    idEst: 54,
    mark: 'W1',
    idFC: 1,
    qty: 4,
    promotionSnapshot: promotion,
  };
  const estimate: any = {
    id: 54,
    idUser: 7,
    order: null,
    ownerMarkupSnapshot: new Decimal('.5'),
    promotionLockedAt: new Date('2020-01-15'),
    // Otra pieza puede tener condiciones distintas: no deben sustituir el 35%.
    promotionContext: [{ ...promotion, percent: '70' }],
    manualDiscount: { lockedAt: '2020-01-15T00:00:00Z' },
  };
  const job: any = {
    id: 40,
    estimateId: 54,
    estimate,
    depositAmountSnapshot: new Decimal(250),
    dealerMeasurementsAcceptedAt: null,
    payments: [{ id: 1 }],
    appointments: [{ id: 1 }],
  };
  const measurement: any = {
    id: 91,
    jobId: 40,
    pieceId: 321,
    piece,
    unitIndex: 1,
    isManual: false,
  };
  // La vista previa no tiene métodos de escritura disponibles en este cliente.
  const tx: any = {
    installationJob: {
      findUnique: jest.fn(async ({ where }) => where.id === job.id ? job : null),
    },
    installationMeasurement: {
      findFirst: jest.fn(async ({ where }) =>
        where.id === measurement.id &&
        where.jobId === measurement.jobId &&
        where.isManual === measurement.isManual &&
        (!where.piece || where.piece.idEst === measurement.piece?.idEst)
          ? measurement
          : null,
      ),
    },
    estimate: {
      findUnique: jest.fn(async () => estimate),
      findUniqueOrThrow: jest.fn(async () => estimate),
    },
  };
  const calculator = {
    createCalculationCache: jest.fn(() => ({})),
    // Solo se simula el motor de precios; se ejecutan el contexto y los permisos reales.
    calculatePieceMetrics: jest.fn(async (data, markup, _tx, cache) => ({
      ...data,
      rate: new Decimal(100),
      price: new Decimal(195),
      regularPrice: new Decimal(300),
      netProfit: new Decimal(95),
      markup,
      subtotal: new Decimal(195),
      dealerMarkupDecimal: new Decimal('.2'),
      netProfitD: new Decimal(39),
      customerPrice: new Decimal(234),
      regularCustomerPrice: new Decimal(360),
      customerSubtotal: new Decimal(234),
      dpPosPsf: new Decimal(70),
      dpNegPsf: new Decimal(80),
      highBottom: false,
      highBottomPercent: null,
      promotionSnapshot: cache.promotions?.[0] ?? null,
    })),
  };
  const prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };
  const workflow = new InstallationWorkflowService(
    prisma as never,
    {} as never,
    {} as never,
    calculator as never,
    {} as never,
    {} as never,
  );
  return { workflow, prisma, tx, calculator, job, estimate, measurement, piece, promotion };
}

describe('Installation replacement preview', () => {
  it.each(['admin', 'operator'] as const)(
    'allows %s to preview a color change on a paid, locked estimate without writing',
    async (role) => {
      const f = fixture();
      const before = JSON.stringify([f.job, f.measurement, input]);
      const result = await f.workflow.calculateMeasurementPiece(
        40, 91, input, { id: role === 'operator' ? 7 : 1, role: { name: role } },
      );
      expect(result.idFC).toBe(2);
      expect(result.qty).toBe(1);
      expect(result.mark).toBe('W1');
      expect(String(result.price)).toBe('195');
      expect(String(result.dealerMarkup)).toBe('0.2');
      expect(String(result.customerSubtotal)).toBe('234');
      expect(result.muntin).toBeNull();
      expect(JSON.stringify([f.job, f.measurement, input])).toBe(before);
      expect(f.tx.installationMeasurement.findFirst).toHaveBeenCalledWith({
        where: { id: 91, jobId: 40, isManual: false, piece: { idEst: 54 } },
        include: expect.any(Object),
      });
    },
  );

  it('uses the owner markup snapshot and the original piece promotion even after expiry', async () => {
    const f = fixture();
    const result = await f.workflow.calculateMeasurementPiece(40, 91, input, admin);
    const [data, markup, tx, cache] = f.calculator.calculatePieceMetrics.mock.calls[0];
    expect(data).toEqual({ ...input, mark: 'W1', qty: 1 });
    expect(String(markup)).toBe('0.5');
    expect(tx).toBe(f.tx);
    expect(cache.promotions).toEqual([f.promotion]);
    expect(result.promotionSnapshot).toEqual(f.promotion);
    expect(f.tx.estimate.findUnique).toHaveBeenCalledWith({
      where: { id: 54 }, select: { ownerMarkupSnapshot: true },
    });
  });

  it('does not borrow another piece promotion when the source has none', async () => {
    const f = fixture();
    f.piece.promotionSnapshot = null;
    await f.workflow.calculateMeasurementPiece(40, 91, input, admin);
    expect(f.calculator.calculatePieceMetrics.mock.calls[0][3].promotions).toEqual([]);
  });

  it('keeps the original mark when the replacement mark is blank', async () => {
    const f = fixture();
    const result = await f.workflow.calculateMeasurementPiece(40, 91, { ...input, mark: '  ' }, admin);
    expect(result.mark).toBe('W1');
  });

  it.each(['client', 'dealer', 'technician'] as const)('rejects a %s before reading the job', async (role) => {
    const f = fixture();
    await expect(f.workflow.calculateMeasurementPiece(
      40, 91, input, { id: 7, role: { name: role } },
    )).rejects.toThrow(ForbiddenException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps the existing job ownership restriction for operators', async () => {
    const f = fixture();
    await expect(f.workflow.calculateMeasurementPiece(
      40, 91, input, { id: 1, role: { name: 'operator' } },
    )).rejects.toThrow(NotFoundException);
    expect(f.calculator.calculatePieceMetrics).not.toHaveBeenCalled();
  });

  it('rejects an unknown job', async () => {
    const f = fixture();
    await expect(f.workflow.calculateMeasurementPiece(99, 91, input, admin)).rejects.toThrow(NotFoundException);
    expect(f.calculator.calculatePieceMetrics).not.toHaveBeenCalled();
  });

  it('does not bypass the order lock', async () => {
    const f = fixture();
    f.estimate.order = { id: 3 };
    await expect(f.workflow.calculateMeasurementPiece(40, 91, input, admin)).rejects.toThrow('after the Order is created');
    expect(f.calculator.calculatePieceMetrics).not.toHaveBeenCalled();
  });

  it('still requires the deposit before remeasurement', async () => {
    const f = fixture();
    f.job.payments = [];
    await expect(f.workflow.calculateMeasurementPiece(40, 91, input, admin)).rejects.toThrow('deposit must be paid');
    expect(f.calculator.calculatePieceMetrics).not.toHaveBeenCalled();
  });

  it('still requires an accepted remeasurement appointment', async () => {
    const f = fixture();
    f.job.appointments = [];
    await expect(f.workflow.calculateMeasurementPiece(40, 91, input, admin)).rejects.toThrow('accept the remeasurement schedule');
    expect(f.calculator.calculatePieceMetrics).not.toHaveBeenCalled();
  });

  it('preserves the existing deposit waiver rule', async () => {
    const f = fixture();
    f.job.depositAmountSnapshot = new Decimal(0);
    f.job.payments = [];
    f.job.appointments = [];
    await expect(f.workflow.calculateMeasurementPiece(40, 91, input, admin)).resolves.toHaveProperty('idFC', 2);
  });

  it('preserves administrator acceptance of dealer measurements', async () => {
    const f = fixture();
    f.job.dealerMeasurementsAcceptedAt = new Date();
    f.job.payments = [];
    f.job.appointments = [];
    await expect(f.workflow.calculateMeasurementPiece(40, 91, input, admin)).resolves.toHaveProperty('idFC', 2);
  });

  it.each(['unknown', 'other-job', 'other-estimate', 'manual', 'missing-piece'])(
    'rejects an invalid occurrence: %s', async (scenario) => {
      const f = fixture();
      if (scenario === 'unknown') f.measurement.id = 92;
      if (scenario === 'other-job') f.measurement.jobId = 41;
      if (scenario === 'other-estimate') f.piece.idEst = 55;
      if (scenario === 'manual') f.measurement.isManual = true;
      if (scenario === 'missing-piece') f.measurement.piece = null;
      await expect(f.workflow.calculateMeasurementPiece(40, 91, input, admin)).rejects.toThrow('occurrence was not found');
      expect(f.calculator.calculatePieceMetrics).not.toHaveBeenCalled();
    },
  );

  it('uses the same calculation when saving the pending replacement, not an estimate edit', async () => {
    const f = fixture();
    await f.workflow.calculateMeasurementPiece(40, 91, input, admin);
    const service = f.workflow as any;
    jest.spyOn(service, 'findJob').mockResolvedValue(f.job);
    jest.spyOn(service, 'withAgreementJobTransaction').mockImplementation(async (_id, work: any) => work(f.tx));
    jest.spyOn(service, 'ensureDraftQuote').mockResolvedValue({ id: 10 });
    jest.spyOn(service, 'ensureDraftRevision').mockResolvedValue({ id: 11, estimateId: 54 });
    jest.spyOn(service, 'calculatedRevisionSnapshot').mockResolvedValue({ price: '195.00' });
    jest.spyOn(service, 'originalRevisionSnapshot').mockReturnValue({ idFC: 1 });
    jest.spyOn(service, 'recomputeRevisionTotals').mockResolvedValue(undefined);
    jest.spyOn(service, 'markQuoteForRecalculation').mockResolvedValue(undefined);
    jest.spyOn(service, 'updateRemeasurementProgress').mockResolvedValue(false);
    f.tx.product = { findUnique: jest.fn(async () => ({ kind: 'GLAZED_UNIT' })) };
    f.tx.installationMeasurement.update = jest.fn(async () => ({}));
    f.tx.estimateRevisionItem = { upsert: jest.fn(async () => ({})) };

    await f.workflow.proposeMeasurementPiece(40, 91, {
      action: 'REPLACE', reason: 'CUSTOMER_REQUEST', piece: input,
    }, admin);
    const [preview, saved] = f.calculator.calculatePieceMetrics.mock.calls;
    expect(saved[0]).toEqual(preview[0]);
    expect(String(saved[1])).toBe(String(preview[1]));
    expect(saved[3].promotions).toEqual(preview[3].promotions);
    const change = f.tx.estimateRevisionItem.upsert.mock.calls[0][0];
    expect(change.create.action).toBe('REPLACE');
    expect(change.create.proposedPieceInput).toEqual({ ...input, mark: 'W1', qty: 1 });
    expect(f.piece.idFC).toBe(1);
  });

  it('exposes a separate POST endpoint restricted to company staff', () => {
    const method = InstallationWorkflowController.prototype.calculateMeasurementPiece;
    expect(Reflect.getMetadata(PATH_METADATA, method)).toBe('installations/:id/measurements/:measurementId/calculate-piece');
    expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual(['admin', 'operator']);
  });
});
