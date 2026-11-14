import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import Decimal from 'decimal.js';
import { InstallationWorkflowService } from './installation-workflow.service';

function fixture(firstId = 100) {
  let nextId = firstId;
  const piece: any = { id: 1, qty: 3, mark: 'W1', idProd: 1, idSyst: 1, idConf: 1, idFC: 1, width: '36', height: '48' };
  const completed = new Date('2026-11-10T12:00:00Z');
  const measurements: any[] = [1, 2, 3].map(unitIndex => ({ id: 10 + unitIndex, jobId: 40, pieceId: 1,
    unitIndex, isManual: false, label: 'W1', status: 'COMPLETED', measuredAt: completed, measuredById: 8,
    widthIn: '36', heightIn: '48', sourceSnapshot: { idFC: 1 } }));
  measurements.push({ id: 21, jobId: 40, pieceId: 2, unitIndex: 1, isManual: false, label: 'D1', status: 'COMPLETED', measuredAt: completed });
  measurements.push({ id: 31, jobId: 40, pieceId: null, unitIndex: 1, isManual: true, label: 'Extra work', status: 'COMPLETED', measuredAt: completed });
  const historical: any = { id: 50, jobId: 40, version: 1, status: 'APPROVED', total: '525.00',
    serviceMinimumsSnapshot: [], coverageSnapshot: null, lines: measurements.map((measurement, index) => ({
      id: index + 1, quoteId: 50, measurementId: measurement.id, origin: measurement.isManual ? 'MANUAL' : 'AUTO',
      adjustedAmount: measurement.id === 21 ? '200.00' : measurement.id === 31 ? '25.00' : '100.00',
      baseAmount: measurement.id === 21 ? '200.00' : measurement.id === 31 ? '25.00' : '100.00', sortOrder: index,
    })) };
  let draft: any;
  let rebuilds = 0;
  const job: any = { id: 40, estimateId: 35, status: 'MATERIAL_PAID', measurements, quotes: [historical] };
  const tx: any = {
    installationJob: { findUnique: async () => job, update: async ({ data }: any) => Object.assign(job, data) },
    installationMeasurement: {
      update: async ({ where, data }: any) => Object.assign(measurements.find(row => row.id === where.id), data),
      create: async ({ data }: any) => { const row = { id: nextId++, ...data }; measurements.push(row); return row; },
    },
    installationQuote: {
      update: async ({ data }: any) => Object.assign(draft, data),
      findUniqueOrThrow: async () => draft,
    },
    installationQuoteLine: {
      deleteMany: async ({ where }: any) => {
        assert.equal(where.quoteId, 51, 'Historical quote must never be changed');
        draft.lines = draft.lines.filter((line: any) => where.measurementId ? !where.measurementId.in.includes(line.measurementId) : false);
      },
      create: async ({ data }: any) => { const row = { id: nextId++, ...data }; draft.lines.push(row); return row; },
    },
  };
  const service: any = Object.create(InstallationWorkflowService.prototype);
  service.measurementCreateFromPiece = (value: any, unitIndex: number) => ({ pieceId: value.id, unitIndex, label: value.mark,
    status: 'PENDING', widthIn: value.width, heightIn: value.height, sourceSnapshot: { idFC: value.idFC } });
  service.ensureDraftQuote = async () => {
    draft = { ...historical, id: 51, version: 2, status: 'DRAFT', lines: historical.lines.map((line: any) => ({ ...line, id: nextId++, quoteId: 51 })) };
    return draft;
  };
  service.rebuildAutomaticLines = async (_job: number, _quote: number, _tx: any, ids: number[]) => {
    rebuilds++;
    draft.lines = draft.lines.filter((line: any) => !ids.includes(line.measurementId));
    for (const id of ids) draft.lines.push({ id: nextId++, quoteId: 51, measurementId: id, origin: 'AUTO', adjustedAmount: '110.00', baseAmount: '110.00', sortOrder: 10 });
  };
  service.recalculateQuoteTotals = async () => {
    draft.total = draft.lines.reduce((sum: Decimal, line: any) => sum.add(line.adjustedAmount), new Decimal(0)).toFixed(2);
    return draft;
  };
  return { service, tx, piece, measurements, historical, job, draft: () => draft, rebuilds: () => rebuilds };
}

describe('Estimate revision installation quantity and removal', () => {
  it('reduces quantity without changing previous quote lines or retained field measurements', async () => {
    const f = fixture(); const history = JSON.stringify(f.historical);
    const result = await f.service.stageMaterialRevisionInstallation(35, [{ key: 'qty', original: f.piece, piece: { ...f.piece, qty: 1 } }], 1, f.tx);
    assert.equal(result.quote.total, '325.00');
    assert.equal(result.status, 'QUOTE_DRAFT');
    assert.equal(f.rebuilds(), 0);
    assert.deepEqual(f.measurements.filter(row => row.pieceId === 1).map(row => row.unitIndex), [1]);
    assert.equal(f.measurements.find(row => row.id === 11).status, 'COMPLETED');
    assert.ok(f.measurements.find(row => row.id === 12).measuredAt);
    assert.equal(f.measurements.find(row => row.id === 12).pieceId, null);
    assert.equal(JSON.stringify(f.historical), history);
    assert.deepEqual(result.quote.lines.map((line: any) => line.measurementId), [11, 21, 31]);
  });

  it('removes original units from the new quote while preserving history and unrelated manual work', async () => {
    const f = fixture(); const history = JSON.stringify(f.historical);
    const result = await f.service.stageMaterialRevisionInstallation(35, [{ key: 'remove', original: f.piece, piece: f.piece, removed: true }], 1, f.tx);
    assert.equal(result.quote.total, '225.00');
    assert.equal(f.measurements.length, 5);
    assert.equal(f.measurements.filter(row => row.pieceId === 1).length, 0);
    assert.deepEqual(result.quote.lines.map((line: any) => line.measurementId), [21, 31]);
    assert.equal(JSON.stringify(f.historical), history);
  });

  it('adds only the extra physical units and preserves installation prices for existing units', async () => {
    const f = fixture();
    const result = await f.service.stageMaterialRevisionInstallation(35, [{ key: 'qty', original: f.piece, piece: { ...f.piece, qty: 4 } }], 1, f.tx);
    assert.equal(result.quote.total, '635.00');
    assert.equal(result.status, 'MEASUREMENT_PENDING');
    assert.deepEqual(f.measurements.filter(row => row.pieceId === 1).map(row => row.status), ['COMPLETED', 'COMPLETED', 'COMPLETED', 'PENDING']);
    assert.equal(result.quote.lines.find((line: any) => line.measurementId === 11).adjustedAmount, '100.00');
  });

  it('applies the saved removal quote without recalculating the approved amount', async () => {
    const preview = fixture();
    const prepared = JSON.parse(JSON.stringify(await preview.service.stageMaterialRevisionInstallation(35,
      [{ key: 'remove', original: preview.piece, piece: preview.piece, removed: true }], 1, preview.tx)));
    const applied = fixture(900);
    applied.service.recalculateQuoteTotals = () => { throw new Error('Approved prices must stay frozen'); };
    const result = await applied.service.stageMaterialRevisionInstallation(35,
      [{ key: 'remove', original: applied.piece, piece: applied.piece, removed: true }], 1, applied.tx, prepared);
    assert.equal(String(result.quote.total), '225');
    assert.equal(applied.rebuilds(), 0);
    assert.deepEqual(result.quote.lines.map((line: any) => line.measurementId), [21, 31]);
  });

  it('rejects a removal that was absent from the approved installation proposal', async () => {
    const f = fixture();
    await assert.rejects(() => f.service.stageMaterialRevisionInstallation(35,
      [{ key: 'remove', original: f.piece, piece: f.piece, removed: true }], 1, f.tx, null), /changed after/);
  });

  it('updates the unit label without asking for measurements again when only its mark changes', async () => {
    const f = fixture();
    const result = await f.service.stageMaterialRevisionInstallation(35,
      [{ key: 'mark', original: f.piece, piece: { ...f.piece, mark: 'W2' } }], 1, f.tx);
    assert.equal(result, null);
    assert.equal(f.measurements[0].label, 'W2');
    assert.equal(f.measurements[0].status, 'COMPLETED');
    assert.equal(f.rebuilds(), 0);
  });

  it('preserves a technician label when a piece is renamed or its dimensions change', async () => {
    for (const updates of [{ mark: 'W2' }, { width: '40' }]) {
      const f = fixture(); f.measurements[0].label = 'Kitchen opening';
      await f.service.stageMaterialRevisionInstallation(35,
        [{ key: 'change', original: f.piece, piece: { ...f.piece, ...updates } }], 1, f.tx);
      assert.equal(f.measurements[0].label, 'Kitchen opening');
    }
  });

  it('preserves retained field measurements that differ from the piece when only quantity or mark changes', async () => {
    for (const updates of [{ qty: 1 }, { qty: 4 }, { mark: 'W2' }]) {
      const f = fixture();
      f.measurements[0].widthIn = '37';
      const measuredAt = f.measurements[0].measuredAt;
      const result = await f.service.stageMaterialRevisionInstallation(35,
        [{ key: 'change', original: f.piece, piece: { ...f.piece, ...updates } }], 1, f.tx);
      assert.equal(f.measurements[0].widthIn, '37');
      assert.equal(f.measurements[0].status, 'COMPLETED');
      assert.equal(f.measurements[0].measuredAt, measuredAt);
      assert.equal(f.measurements[0].measuredById, 8);
      const quote = result?.quote ?? f.historical;
      assert.equal(quote.lines.find((line: any) => line.measurementId === 11).adjustedAmount, '100.00');
      assert.equal(f.rebuilds(), updates.qty === 4 ? 1 : 0);
    }
  });
});
