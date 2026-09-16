import { Prisma } from '@prisma/client';
import { EstimatePieceCalculatorService } from '@/estimates/calculation/estimate-piece-calculator.service';
import { EstimateMuntinService } from '@/estimates/muntins/estimate-muntin.service';
import { InstallationWorkflowService } from './installation-workflow.service';

const dec = (value: number | string) => new Prisma.Decimal(value);

function fixture(qty = 1, mark = '') {
  const original: any = {
    id: 24,
    idEst: 23,
    mark,
    qty,
    idProd: 1,
    idBrand: 1,
    idSyst: 1,
    idConf: 1,
    idFC: 1,
    prod: { name: 'Horizontal Rolling', kind: 'GLAZED_UNIT' },
    syst: { name: '200' },
    conf: { conf: 'OX' },
    pieceMuntin: null,
    width: dec(56),
    height: dec(38),
    rate: dec(100),
    price: dec(150),
    customerPrice: dec(150),
    regularPrice: dec(150),
    regularCustomerPrice: dec(150),
    netProfit: dec(50),
    markup: dec(0),
    dealerMarkup: dec(0),
    subtotal: dec(150 * qty),
    customerSubtotal: dec(150 * qty),
    createdAt: new Date('2026-09-14'),
    updatedAt: new Date('2026-09-14'),
  };
  const other = {
    ...original,
    id: 25,
    qty: 1,
    prod: { name: 'Single Hung', kind: 'GLAZED_UNIT' },
    width: dec(36),
    height: dec(57),
    price: dec(250),
    customerPrice: dec(250),
    regularPrice: dec(250),
    regularCustomerPrice: dec(250),
    subtotal: dec(250),
    customerSubtotal: dec(250),
  };
  const pieces = new Map<number, any>([
    [24, original],
    [25, other],
  ]);
  const measurements = new Map<number, any>();
  const estimate: any = {
    id: 23,
    number: '190932',
    order: null,
    taxRate: dec('.07'),
    customerTaxRate: dec('.07'),
  };
  const revision: any = {
    id: 2,
    estimateId: 23,
    installationJobId: 20,
    version: 2,
    status: 'PENDING_CUSTOMER_APPROVAL',
    items: [],
  };
  let nextId = 25;
  const ordered = () => [...pieces.values()].sort((a, b) => a.id - b.id);
  const tx: any = {
    piece: {
      findMany: jest.fn(async () => ordered()),
      findUniqueOrThrow: jest.fn(async ({ where }) => pieces.get(where.id)),
      update: jest.fn(async ({ where, data }) => {
        const updated = { ...pieces.get(where.id), ...data };
        pieces.set(where.id, updated);
        return updated;
      }),
      create: jest.fn(async ({ data }) => {
        const created = { ...data, id: ++nextId, pieceMuntin: null };
        pieces.set(created.id, created);
        return created;
      }),
      delete: jest.fn(async ({ where }) => pieces.delete(where.id)),
    },
    pieceMuntin: {
      deleteMany: jest.fn(async ({ where }) => {
        pieces.get(where.pieceId).pieceMuntin = null;
      }),
      create: jest.fn(async ({ data }) => {
        pieces.get(data.piece.connect.id).pieceMuntin = {
          id: 99,
          patternId: data.pattern.connect.id,
          typeId: data.type?.connect.id ?? null,
          panels: data.panels?.create ?? [],
          totalLites: data.totalLites,
        };
      }),
    },
    installationMeasurement: {
      updateMany: jest.fn(async ({ where, data }) => {
        for (const id of where.id.in) Object.assign(measurements.get(id), data);
      }),
      update: jest.fn(async ({ where, data }) => {
        const current = measurements.get(where.id);
        const result = { ...current, ...data };
        // Reproduce la restricción real para detectar colisiones al separar unidades.
        if (
          result.pieceId != null &&
          [...measurements.values()].some(
            (m) =>
              m.id !== result.id &&
              m.jobId === result.jobId &&
              m.pieceId === result.pieceId &&
              m.unitIndex === result.unitIndex,
          )
        )
          throw new Error('Duplicate piece/unit reference');
        Object.assign(current, data);
        return current;
      }),
    },
    estimateRevision: {
      findUnique: jest.fn(async () => ({
        ...revision,
        estimate: { ...estimate, pieces: ordered() },
        items: revision.items.map((item: any) => ({
          ...item,
          measurement: { label: measurements.get(item.measurementId).label },
        })),
      })),
      updateMany: jest.fn(async () => ({ count: 0 })),
      update: jest.fn(async ({ data }) => Object.assign(revision, data)),
    },
    estimate: {
      update: jest.fn(async ({ data }) => Object.assign(estimate, data)),
    },
    eventLog: { create: jest.fn() },
  };
  const calculator = Object.create(EstimatePieceCalculatorService.prototype);
  const workflow: any = new InstallationWorkflowService(
    {} as any,
    {} as any,
    {} as any,
    calculator,
    new EstimateMuntinService(),
    {} as any,
  );
  for (const piece of ordered()) {
    for (let unit = 1; unit <= piece.qty; unit++) {
      const id = piece.id * 100 + unit;
      const snapshot = workflow.originalRevisionSnapshot(piece);
      measurements.set(id, {
        id,
        jobId: 20,
        pieceId: piece.id,
        unitIndex: unit,
        label: piece.mark || `#${piece.id === 24 ? 1 : 2}`,
      });
      revision.items.push({
        measurementId: id,
        originalPieceId: piece.id,
        sourceUnitIndex: unit,
        action: 'UNCHANGED',
        originalSnapshot: snapshot,
        proposedPieceInput: snapshot.pieceInput,
        calculatedSnapshot: snapshot.pricing,
      });
    }
  }
  const item = (unit = 1) =>
    revision.items.find((row: any) => row.measurementId === 2400 + unit);
  function change(unit = 1, height = 40) {
    const row = item(unit);
    row.action = 'UPDATE';
    row.proposedPieceInput = { ...row.proposedPieceInput, height };
    row.calculatedSnapshot = {
      ...row.calculatedSnapshot,
      price: '160',
      customerPrice: '160',
      regularPrice: '160',
      regularCustomerPrice: '160',
      netProfit: '60',
    };
    return row;
  }
  return {
    original,
    other,
    pieces,
    measurements,
    estimate,
    revision,
    tx,
    ordered,
    item,
    change,
    apply: () => workflow.applyEstimateRevision(2, 7, tx),
  };
}

describe('Applying an approved material revision', () => {
  it('updates the original piece and keeps its position, Mark, creation date and estimate', async () => {
    const f = fixture();
    f.change();
    const proposal = JSON.stringify(f.revision.items);
    await f.apply();
    expect(f.ordered().map((p) => p.id)).toEqual([24, 25]);
    expect(f.pieces.get(24)).toMatchObject({
      idEst: 23,
      mark: '',
      height: dec(40),
      createdAt: f.original.createdAt,
    });
    expect(f.pieces.get(25)).toBe(f.other);
    expect(f.tx.piece.create).not.toHaveBeenCalled();
    expect(f.tx.piece.delete).not.toHaveBeenCalled();
    expect(f.tx.piece.update).toHaveBeenCalledTimes(1);
    expect(f.measurements.get(2401)).toMatchObject({
      pieceId: 24,
      label: '#1',
    });
    expect(f.measurements.get(2501)).toMatchObject({
      pieceId: 25,
      label: '#2',
    });
    expect(f.estimate.id).toBe(23);
    expect(f.estimate.totalPayable.toString()).toBe('438.7');
    expect(f.estimate.customerTotalPayable.toString()).toBe('438.7');
    expect(f.revision.status).toBe('APPROVED');
    expect(JSON.stringify(f.revision.items)).toBe(proposal);
  });

  it('keeps one existing row when every unit receives the same new dimensions', async () => {
    const f = fixture(3, 'Living room');
    [1, 2, 3].forEach((unit) => f.change(unit));
    await f.apply();
    expect(f.pieces.get(24)).toMatchObject({
      mark: 'Living room',
      qty: 3,
      height: dec(40),
      subtotal: dec(480),
    });
    expect(f.pieces.size).toBe(2);
    expect(f.tx.piece.create).not.toHaveBeenCalled();
  });

  it('retains the unchanged units and appends only the different unit', async () => {
    const f = fixture(3);
    f.change(1);
    await f.apply();
    expect(f.ordered().map((p) => p.id)).toEqual([24, 25, 26]);
    expect(f.pieces.get(24)).toMatchObject({
      qty: 2,
      height: dec(38),
      price: dec(150),
      subtotal: dec(300),
    });
    expect(f.pieces.get(26)).toMatchObject({
      idEst: 23,
      qty: 1,
      height: dec(40),
      mark: '#1-1',
    });
    expect(f.measurements.get(2401)).toMatchObject({
      pieceId: 26,
      unitIndex: 1,
      label: '#1-1',
    });
    expect(f.measurements.get(2402)).toMatchObject({
      pieceId: 24,
      unitIndex: 1,
      label: '#1',
    });
    expect(f.measurements.get(2403)).toMatchObject({
      pieceId: 24,
      unitIndex: 2,
    });
    expect(f.tx.piece.create).toHaveBeenCalledTimes(1);
    expect(f.tx.piece.delete).not.toHaveBeenCalled();
  });

  it('retains the first group when all units change to different dimensions', async () => {
    const f = fixture(2, 'W1');
    f.change(1, 40);
    f.change(2, 41);
    await f.apply();
    expect(f.pieces.get(24)).toMatchObject({
      qty: 1,
      height: dec(40),
      mark: 'W1',
    });
    expect(f.pieces.get(26)).toMatchObject({
      qty: 1,
      height: dec(41),
      mark: 'W1-2',
    });
    expect(f.measurements.get(2401).pieceId).toBe(24);
    expect(f.measurements.get(2402).pieceId).toBe(26);
    expect(f.tx.piece.delete).not.toHaveBeenCalled();
  });

  it('reduces quantity in place when one unit is removed', async () => {
    const f = fixture(2);
    f.item(1).action = 'REMOVE';
    await f.apply();
    expect(f.pieces.get(24)).toMatchObject({
      qty: 1,
      subtotal: dec(150),
      mark: '',
    });
    expect(f.measurements.get(2401).pieceId).toBeNull();
    expect(f.measurements.get(2402)).toMatchObject({
      pieceId: 24,
      unitIndex: 1,
    });
    expect(f.tx.piece.delete).not.toHaveBeenCalled();
    expect(f.tx.piece.create).not.toHaveBeenCalled();
  });

  it('deletes a piece only when all of its units are explicitly removed', async () => {
    const f = fixture(2);
    f.item(1).action = 'REMOVE';
    f.item(2).action = 'REMOVE';
    await f.apply();
    expect(f.ordered()).toEqual([f.other]);
    expect(f.tx.piece.delete).toHaveBeenCalledWith({ where: { id: 24 } });
    expect(f.tx.piece.update).not.toHaveBeenCalled();
    expect(f.estimate.units).toBe(1);
  });

  it('keeps an edited field label while updating the piece', async () => {
    const f = fixture();
    f.change();
    f.measurements.get(2401).label = 'Kitchen west';
    await f.apply();
    expect(f.measurements.get(2401)).toMatchObject({
      pieceId: 24,
      label: 'Kitchen west',
    });
  });

  it('preserves the existing muntin for dimension-only updates', async () => {
    const f = fixture();
    const muntin = {
      idPattern: 1,
      idType: 2,
      panels: [
        {
          panelIndex: 1,
          panelLabel: 'Glass',
          horizontalLites: 2,
          verticalLites: 2,
        },
      ],
    };
    const persisted = {
      id: 10,
      patternId: 1,
      typeId: 2,
      panels: muntin.panels,
    };
    f.original.pieceMuntin = persisted;
    const row = f.change();
    row.proposedPieceInput.muntin = muntin;
    await f.apply();
    expect(f.pieces.get(24).pieceMuntin).toBe(persisted);
    expect(f.tx.pieceMuntin.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.pieceMuntin.create).not.toHaveBeenCalled();
  });

  it('applies replacement configuration to the same piece, including its new muntin', async () => {
    const f = fixture();
    const row = f.change();
    row.action = 'REPLACE';
    row.proposedPieceInput = {
      ...row.proposedPieceInput,
      idConf: 3,
      muntin: {
        idPattern: 2,
        panels: [
          {
            panelIndex: 1,
            panelLabel: 'New glass',
            horizontalLites: 3,
            verticalLites: 2,
          },
        ],
      },
    };
    await f.apply();
    expect(f.pieces.get(24)).toMatchObject({
      idConf: 3,
      pieceMuntin: { patternId: 2, totalLites: 6 },
    });
    expect(f.pieces.size).toBe(2);
    expect(f.tx.piece.create).not.toHaveBeenCalled();
  });

  it('does not write to pieces or measurement references when only labels changed', async () => {
    const f = fixture();
    f.measurements.get(2401).label = 'Kitchen';
    await f.apply();
    expect(f.tx.piece.update).not.toHaveBeenCalled();
    expect(f.tx.piece.create).not.toHaveBeenCalled();
    expect(f.tx.piece.delete).not.toHaveBeenCalled();
    expect(f.tx.installationMeasurement.updateMany).not.toHaveBeenCalled();
  });

  it.each(['APPROVED', 'REJECTED', 'PENDING_ADMIN_APPROVAL'])(
    'does not apply a %s revision',
    async (status) => {
      const f = fixture();
      f.change();
      f.revision.status = status;
      await expect(f.apply()).rejects.toThrow('not awaiting customer approval');
      expect(f.tx.piece.update).not.toHaveBeenCalled();
    },
  );

  it('refuses material edits after order creation', async () => {
    const f = fixture();
    f.change();
    f.estimate.order = { id: 9 };
    await expect(f.apply()).rejects.toThrow('after the Order');
    expect(f.tx.piece.update).not.toHaveBeenCalled();
  });

  it('refuses an incomplete unit proposal before changing pieces', async () => {
    const f = fixture(2);
    f.change();
    f.revision.items.splice(1, 1);
    await expect(f.apply()).rejects.toThrow('one revision result per unit');
    expect(f.tx.piece.update).not.toHaveBeenCalled();
  });
});
