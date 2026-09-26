import { strict as assert } from 'node:assert';
import Decimal from 'decimal.js';
import { InstallationWorkflowService } from './installation-workflow.service';
import { EstimatePieceCalculatorService } from '@/estimates/calculation/estimate-piece-calculator.service';
import { MaterialRevisionsService } from '@/estimates/material-revisions/material-revisions.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import type { CreatePieceDto } from '@/pieces/dto/create-piece.dto';

const admin: AuthUser = { id: 1, role: { name: 'admin' } };
const d = (value: any) => new Decimal(String(value ?? 0));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const newPiece = (overrides: Partial<CreatePieceDto> = {}): CreatePieceDto => ({
  mark: 'NEW', idProd: 1, idBrand: 1, idSyst: 1, idConf: 1, idFC: 1,
  idCryst: 1, idTint: 1, idCoat: 1, idPrivacy: 1,
  width: '30', height: '40', panelCount: 1, qty: 1, dealerMarkup: 25,
  ...overrides,
});

// Persistencia y catálogo simulados; se ejecutan los métodos reales de revisión,
// medición, agrupación, totales y creación de líneas automáticas.
function fixture() {
  let nextId = 100;
  const calls: any[] = [];
  const state: any = {
    factor: 1,
    estimate: { id: 35, number: 'EST-35', idUser: 7, units: 1, status: { name: 'Active' }, order: null,
      user: { id: 7, role: { name: 'dealer' } }, ownerMarkupSnapshot: '0.5', dealerModeSnapshot: 'EXTERNAL',
      dealerEarningsPlanSnapshot: { percent: '50' }, paymentPlanSnapshot: null, promotionLockedAt: new Date(),
      taxRate: '0.07', customerTaxRate: '0.07', manualDiscount: null },
    pieces: [{ id: 10, idEst: 35, ...newPiece({ mark: 'ORIGINAL', width: '40', height: '50' }),
      rate: '200', price: '300', customerPrice: '375', regularPrice: '300', regularCustomerPrice: '375',
      markup: '0.5', dealerMarkup: '0.25', subtotal: '300', customerSubtotal: '375',
      netProfit: '100', netProfitD: '75', promotionSnapshot: null, dpPosPsf: '60', dpNegPsf: '70',
      screen: false, highBottom: false, highBottomPercent: null, pieceMuntin: null }],
    job: { id: 40, estimateId: 35, status: 'MEASUREMENT_PENDING', depositAmountSnapshot: '250',
      dealerMeasurementsAcceptedAt: null, completedAt: null, permitRequested: false },
    measurements: [{ id: 20, jobId: 40, pieceId: 10, unitIndex: 1, label: 'ORIGINAL', isManual: false,
      status: 'PENDING', widthIn: '40', heightIn: '50', panelCount: 1, measuredAt: null,
      heightLeftIn: null, heightRightIn: null, legHeightIn: null, sashHeightIn: null, windowHeightIn: null,
      doorWidthIn: null, doorHeightIn: null, leftSideliteWidthIn: null, rightSideliteWidthIn: null,
      leftPanels: null, rightPanels: null, horizontalHeights: null, lengthIn: null }],
    quotes: [{ id: 50, jobId: 40, version: 1, status: 'DRAFT', approvalReason: 'REMEASUREMENT',
      profileId: null, profileNameSnapshot: 'Original', profileAdjustmentPercent: '0', profileMinimumSnapshot: '0',
      baseSubtotal: '125', adjustedSubtotal: '125', total: '125', needsRecalculation: false,
      serviceMinimumsSnapshot: [], minimumAdjustment: '0', serviceMinimumAdjustment: '0', installationSurcharge: '0',
      submittedAt: null, approvedAt: null, coverageSnapshot: null }],
    lines: [{ id: 60, quoteId: 50, measurementId: 20, serviceId: 1, origin: 'AUTO', baseAmount: '100', adjustedAmount: '100' },
      { id: 61, quoteId: 50, measurementId: null, serviceId: 2, origin: 'USER_SELECTED', baseAmount: '25', adjustedAmount: '25' }],
    payments: [{ id: 70, installationJobId: 40, type: 'INSTALLATION_DEPOSIT', status: 'PAID', baseAmount: '250', stripeSessionId: null }],
    appointments: [{ id: 80, jobId: 40, type: 'REMEASUREMENT', status: 'ACCEPTED' }],
    revisions: [], items: [], approvals: [], logs: [], materialRevisions: [],
  };
  const matches = (row: any, where: any): boolean => !where || Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((part: any) => matches(row, part));
    if (key === 'revisionItems') return state.items.some((item: any) => item.measurementId === row.id && matches(item, value.some));
    if (key === 'revision') return matches(state.revisions.find((revision: any) => revision.id === row.revisionId), value);
    if (key === 'piece') return matches(state.pieces.find((piece: any) => piece.id === row.pieceId), value);
    if (!row) return false;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
      if ('lt' in value) return row[key] < value.lt;
      if ('gt' in value) return row[key] > value.gt;
      return matches(row[key], value);
    }
    return row[key] === value;
  });
  const relations = (piece: any) => piece && ({ ...piece,
    prod: { id: piece.idProd, name: 'Window', kind: piece.idProd === 2 ? 'LINEAR_MATERIAL' : 'GLAZED_UNIT' },
    bran: { name: 'Brand' }, syst: { name: 'System' }, conf: { conf: 'OX', fixedPanelCount: 1 },
    fColor: { color: 'White' }, cryst: { glass: 'Clear' }, pieceMuntin: null });
  const estimate = () => ({ ...state.estimate, pieces: state.pieces.map(relations), payments: state.payments,
    materialRevisions: state.materialRevisions });
  const quote = (row: any) => row && ({ ...row, lines: state.lines.filter((line: any) => line.quoteId === row.id),
    approvals: state.approvals.filter((approval: any) => approval.quoteId === row.id), coverageSnapshot: null });
  const revision = (row: any) => row && ({ ...row,
    items: state.items.filter((item: any) => item.revisionId === row.id).map((item: any) => ({ ...item,
      measurement: state.measurements.find((measurement: any) => measurement.id === item.measurementId) })),
    estimate: estimate(), installationJob: { measurements: state.measurements.filter((m: any) => m.pieceId != null && !m.isManual) } });
  const job = () => ({ ...state.job, estimate: estimate(), measurements: state.measurements,
    quotes: [...state.quotes].sort((a: any, b: any) => b.version - a.version).map(quote),
    revisions: [...state.revisions].sort((a: any, b: any) => b.version - a.version).map(revision),
    payments: state.payments, appointments: state.appointments, permit: null });
  const collection = (key: string, present: (row: any) => any = (row) => row) => ({
    findMany: async ({ where } = {} as any) => state[key].filter((row: any) => matches(row, where)).map(present),
    findFirst: async ({ where, orderBy } = {} as any) => {
      const rows = state[key].filter((row: any) => matches(row, where));
      if (orderBy?.version === 'desc') rows.sort((a: any, b: any) => b.version - a.version);
      return present(rows[0]) ?? null;
    },
    findUnique: async ({ where }: any) => present(state[key].find((row: any) => matches(row, where))) ?? null,
    findUniqueOrThrow: async ({ where }: any) => {
      const row = state[key].find((row: any) => matches(row, where));
      if (!row) throw new Error(`Missing ${key}`); return present(row);
    },
    create: async ({ data }: any) => {
      const { items, lines, ...fields } = data;
      const row = { id: nextId++, ...copy(fields), createdAt: new Date(), updatedAt: new Date() };
      state[key].push(row);
      if (items?.create) for (const item of items.create) state.items.push({ id: nextId++, revisionId: row.id, ...copy(item) });
      if (lines?.create) for (const line of lines.create) state.lines.push({ id: nextId++, quoteId: row.id, ...copy(line) });
      return present(row);
    },
    update: async ({ where, data }: any) => {
      const row = state[key].find((row: any) => matches(row, where));
      if (!row) throw new Error(`Missing ${key} for update`);
      Object.assign(row, copy(data), { updatedAt: new Date() }); return present(row);
    },
    updateMany: async ({ where, data }: any) => {
      const rows = state[key].filter((row: any) => matches(row, where));
      rows.forEach((row: any) => Object.assign(row, copy(data))); return { count: rows.length };
    },
    delete: async ({ where }: any) => {
      const index = state[key].findIndex((row: any) => matches(row, where));
      if (index < 0) throw new Error(`Missing ${key} for deletion`);
      return state[key].splice(index, 1)[0];
    },
    deleteMany: async ({ where }: any) => {
      const rows = state[key].filter((row: any) => matches(row, where));
      state[key] = state[key].filter((row: any) => !matches(row, where)); return { count: rows.length };
    },
    count: async ({ where } = {} as any) => state[key].filter((row: any) => matches(row, where)).length,
  });
  const db: any = {
    estimate: { findUnique: async () => estimate(), findUniqueOrThrow: async () => estimate(), findFirst: async () => estimate(),
      update: async ({ data }: any) => Object.assign(state.estimate, copy(data)) },
    installationJob: { findUnique: async ({ where, select }: any) => {
      if (where.id && where.id !== state.job.id) return null;
      const value = job();
      if (select?.payments?.where) value.payments = state.payments.filter((row: any) => matches(row, select.payments.where));
      if (select?.appointments?.where) value.appointments = state.appointments.filter((row: any) => matches(row, select.appointments.where));
      return value;
    }, update: async ({ data }: any) => Object.assign(state.job, copy(data)) },
    piece: collection('pieces', relations), installationQuote: collection('quotes', quote),
    estimateRevision: collection('revisions', revision), estimateRevisionItem: collection('items'),
    installationMeasurement: collection('measurements', (row) => row && ({ ...row, piece: relations(state.pieces.find((p: any) => p.id === row.pieceId)) })),
    installationQuoteLine: collection('lines'), installationQuoteApproval: collection('approvals'),
    installationAppointment: collection('appointments'), payment: collection('payments'), eventLog: collection('logs'),
    materialRevision: collection('materialRevisions'),
    installationPermit: { findUnique: async () => null },
    estimateAgreement: { findMany: async () => [], findFirst: async () => null, updateMany: async () => ({ count: 0 }) },
    product: { findUnique: async ({ where }: any) => ({ id: where.id, name: 'Window', kind: where.id === 2 ? 'LINEAR_MATERIAL' : 'GLAZED_UNIT' }) },
    brand: { findUnique: async () => ({ name: 'Brand' }) }, system: { findUnique: async () => ({ name: 'System' }) },
    config: { findUnique: async () => ({ conf: 'OX', fixedPanelCount: 1 }) }, crystal: { findUnique: async () => ({ glass: 'Clear' }) },
    sysConf: { findUnique: async () => ({ config: { conf: 'OX', fixedPanelCount: 1 }, dimensionMode: 'STANDARD', pricingComponents: [],
      installationServices: [{ service: { id: 1, name: 'Install', isActive: true, rules: [] } }] }) },
    pieceMuntin: { deleteMany: async () => ({ count: 0 }) }, $queryRaw: async () => [{ id: 35 }],
  };
  db.estimateRevisionItem.upsert = async ({ where, create, update }: any) => {
    const row = state.items.find((item: any) => matches(item, where.revisionId_measurementId));
    return row ? db.estimateRevisionItem.update({ where: { id: row.id }, data: update }) : db.estimateRevisionItem.create({ data: create });
  };
  db.$transaction = async (work: any) => {
    const before = copy(state);
    try { return await work(db); } catch (error) { Object.assign(state, before); throw error; }
  };
  const calculator = new EstimatePieceCalculatorService({} as never, {} as never);
  calculator.calculatePieceMetrics = async (input: any, markup: any, _db: any, cache: any) => {
    calls.push({ input: copy(input), markup: String(markup), promotions: copy(cache.promotions ?? []) });
    if (Number(input.width) <= 0) throw new Error('Invalid width');
    const rate = d(input.width).mul(5).mul(state.factor), price = rate.mul(d(1).add(markup));
    const customerPrice = price.mul(d(1).add(d(input.dealerMarkup).div(100)));
    return { ...input, screen: Boolean(input.screen), panelCount: 1, highBottom: Boolean(input.highBottom),
      highBottomPercent: null, rate, price, regularPrice: price, regularCustomerPrice: customerPrice, customerPrice,
      markup: d(markup), dealerMarkupDecimal: d(input.dealerMarkup).div(100), netProfit: price.sub(rate),
      subtotal: price.mul(input.qty), customerSubtotal: customerPrice.mul(input.qty), netProfitD: customerPrice.sub(price).mul(input.qty),
      dpPosPsf: d(60), dpNegPsf: d(70), promotionSnapshot: cache.promotions?.[0] ?? null };
  };
  const pricing: any = { calculateLine: (input: any) => ({ serviceId: 1, measurementId: input.measurementId,
    origin: 'AUTO', sourceSystemId: input.sourceSystemId, sourceConfigId: input.sourceConfigId,
    baseAmount: String(100 + Number(input.dimensions.widthIn ?? 0)), adjustedAmount: String(100 + Number(input.dimensions.widthIn ?? 0)) }) };
  const notifications: any = { createAndSend: async () => null, createAndSendToRoles: async () => null };
  const workflow = new InstallationWorkflowService(db, pricing, {} as never, calculator,
    { buildPieceMuntinCreateInput: () => null } as never, notifications);
  const engine = workflow as any;
  engine.promotions = { eligible: async (ownerId: number) => { assert.equal(ownerId, 7); return []; } };
  engine.recalculateQuoteTotals = async (id: number) => {
    const total = state.lines.filter((line: any) => line.quoteId === id).reduce((sum: Decimal, line: any) => sum.add(line.adjustedAmount), d(0));
    await db.installationQuote.update({ where: { id }, data: { total: total.toFixed(2) } });
  };
  engine.rebuildManualLines = async () => {};
  // Los helpers de acuerdos y pagos son externos a la operación que se está probando.
  engine.findJob = async (id: number, user: AuthUser) => {
    const found = await engine.getJobRecord(id, db);
    if (!found) throw new Error('Installation job not found.'); engine.assertAccess(found, user); return found;
  };
  engine.withAgreementJobTransaction = async (_id: number, work: any) => db.$transaction(work);
  Object.assign(state.estimate, calculator.calculateEstimateTotalsFromPersistedPieces(state.pieces, d('.07') as never, d('.07') as never));
  return { state, db, workflow, engine, calls, calculator, job, estimate, notifications };
}

async function add(f: ReturnType<typeof fixture>, qty = 1, actor = admin) {
  return f.workflow.saveAddedPiece(40, { quoteId: f.state.quotes[f.state.quotes.length - 1].id, piece: newPiece({ qty }) }, actor);
}
async function confirmAll(f: ReturnType<typeof fixture>) {
  for (const measurement of [...f.state.measurements]) {
    await f.workflow.updateMeasurement(40, measurement.id, { label: measurement.label }, admin);
  }
}

describe('Combined remeasurement and added pieces', () => {
  it('adds a piece to an already saved dimension revision without closing it', async () => {
    const f = fixture(); const before = copy([f.state.pieces, f.state.payments, f.state.estimate.dealerEarningsPlanSnapshot]);
    await f.workflow.updateMeasurement(40, 20, { widthIn: 42 }, admin);
    const revisionId = f.state.revisions[0].id; const change = copy(f.state.items[0]);
    await add(f);
    assert.equal(f.state.revisions.length, 1); assert.equal(f.state.revisions[0].id, revisionId);
    assert.deepEqual(copy(f.state.items.find((row: any) => row.id === change.id)), change);
    assert.deepEqual(f.state.items.map((row: any) => row.action), ['UPDATE', 'ADD']);
    assert.deepEqual(copy([f.state.pieces, f.state.payments, f.state.estimate.dealerEarningsPlanSnapshot]), before);
  });
  it('adds first and then changes original dimensions in the same revision', async () => {
    const f = fixture(); await add(f); const id = f.state.revisions[0].id;
    await f.workflow.updateMeasurement(40, 20, { widthIn: 44 }, admin);
    assert.equal(f.state.revisions.length, 1); assert.equal(f.state.revisions[0].id, id);
    assert.equal(f.state.items.filter((row: any) => row.action === 'ADD').length, 1);
    assert.equal(f.state.items.find((row: any) => row.originalPieceId === 10).action, 'UPDATE');
  });
  it('previews without creating a revision, piece, measurement or payment', async () => {
    const f = fixture(); const before = copy(f.state);
    const result = await f.workflow.calculateAddedPiece(40, { piece: newPiece() }, admin);
    assert.equal(String(result.price), '225'); assert.deepEqual(copy(f.state), before);
  });
  it('creates one pending measurement per added unit and counts each only once', async () => {
    const f = fixture(); await add(f, 3);
    assert.equal(f.state.pieces.length, 1); assert.equal(f.state.items.length, 3);
    assert.equal(f.state.measurements.filter((row: any) => row.pieceId == null && row.status === 'PENDING').length, 3);
    assert(f.state.items.every((row: any) => row.proposedPieceInput.qty === 1));
    assert.equal(f.state.revisions[0].revisedTotals.units, 4);
    assert.equal(f.state.revisions[0].revisedTotals.priceT, '975.00');
    assert.equal(f.state.revisions[0].revisedTotals.taxAmount, '68.25');
  });
  it('preserves original installation and requested service lines when adding units', async () => {
    const f = fixture(); const lines = copy(f.state.lines); await add(f, 2);
    assert.deepEqual(f.state.lines.filter((row: any) => [60, 61].includes(row.id)), lines);
    assert.equal(f.state.lines.length, 4); assert.equal(f.state.quotes[0].total, '385.00');
  });
  it('confirms a proposed unit without creating material or repricing it', async () => {
    const f = fixture(); await add(f); const item = f.state.items[0]; const price = item.calculatedSnapshot.price;
    f.state.factor = 9; const calls = f.calls.length;
    await f.workflow.updateMeasurement(40, item.measurementId, { label: 'NEW' }, admin);
    assert.equal(f.state.items[0].calculatedSnapshot.price, price); assert.equal(f.calls.length, calls);
    assert.equal(f.state.measurements.find((row: any) => row.id === item.measurementId).status, 'COMPLETED');
    assert.equal(f.state.pieces.length, 1);
  });
  it('reopens only the changed added unit for measurement', async () => {
    const f = fixture(); await add(f, 2); await confirmAll(f); const item = f.state.items[0];
    await f.workflow.saveAddedPiece(40, { piece: newPiece({ width: '32' }), measurementId: item.measurementId, quoteId: 50 }, admin);
    assert.equal(f.state.measurements.find((row: any) => row.id === item.measurementId).status, 'PENDING');
    assert.equal(f.state.measurements.find((row: any) => row.id === 20).status, 'COMPLETED');
    assert.equal(f.state.measurements.filter((row: any) => row.status === 'PENDING').length, 1);
  });
  it('does not clear a confirmed measurement when only color changes', async () => {
    const f = fixture(); await add(f); await confirmAll(f); const item = f.state.items[0];
    await f.workflow.saveAddedPiece(40, { piece: newPiece({ idFC: 2 }), measurementId: item.measurementId }, admin);
    assert.equal(f.state.measurements.find((row: any) => row.id === item.measurementId).status, 'COMPLETED');
  });
  it('removes a proposed addition without deleting original material or changes', async () => {
    const f = fixture(); await f.workflow.updateMeasurement(40, 20, { widthIn: 42 }, admin); await add(f);
    const added = f.state.items.find((row: any) => row.action === 'ADD');
    await f.workflow.removeAddedPiece(40, added.measurementId, admin);
    assert.equal(f.state.items.length, 1); assert.equal(f.state.items[0].action, 'UPDATE');
    assert.equal(f.state.pieces.length, 1); assert.equal(f.state.revisions[0].revisedTotals.units, 1);
  });
  it('requires all added units to be measured before submitting the combined quote', async () => {
    const f = fixture(); await f.workflow.updateMeasurement(40, 20, { widthIn: 42 }, admin); await add(f);
    await assert.rejects(() => f.workflow.submitQuote(40, {}, admin), /field measurement|completed remeasurement/);
    assert.equal(f.state.revisions[0].status, 'DRAFT');
  });
  it('submits dimension changes and additions together for the existing approval stages', async () => {
    const f = fixture(); await f.workflow.updateMeasurement(40, 20, { widthIn: 42 }, admin); await add(f, 2); await confirmAll(f);
    await f.workflow.submitQuote(40, {}, admin);
    assert.equal(f.state.revisions[0].status, 'PENDING_ADMIN_APPROVAL');
    assert.equal(f.state.items.length, 3); assert.equal(f.state.quotes[0].status, 'PENDING_ADMIN_APPROVAL');
    assert.equal(f.state.pieces.length, 1);
    await f.workflow.adminDecision(40, { decision: 'APPROVED' } as any, admin);
    assert.equal(f.state.revisions[0].status, 'PENDING_CUSTOMER_APPROVAL');
  });
  it('applies the combined approved revision once, grouping identical added units', async () => {
    const f = fixture(); const paid = copy(f.state.payments), earnings = copy(f.state.estimate.dealerEarningsPlanSnapshot);
    await f.workflow.updateMeasurement(40, 20, { widthIn: 42 }, admin); await add(f, 2); await confirmAll(f);
    await f.workflow.submitQuote(40, {}, admin); await f.workflow.adminDecision(40, { decision: 'APPROVED' } as any, admin);
    const id = f.state.revisions[0].id; const calls = f.calls.length;
    await f.engine.applyEstimateRevision(id, 7, f.db);
    assert.equal(f.calls.length, calls); assert.equal(f.state.estimate.id, 35);
    assert.equal(f.state.pieces.length, 2); assert.equal(f.state.pieces[0].id, 10); assert.equal(String(f.state.pieces[0].width), '42');
    assert.equal(f.state.pieces.find((row: any) => row.mark === 'NEW').qty, 2);
    assert.equal(f.state.estimate.units, 3); assert.equal(String(f.state.estimate.priceT), '765');
    assert.deepEqual(f.state.payments, paid); assert.deepEqual(f.state.estimate.dealerEarningsPlanSnapshot, earnings);
    assert(f.state.measurements.every((row: any) => row.pieceId != null));
    await assert.rejects(() => f.engine.applyEstimateRevision(id, 7, f.db), /not awaiting/);
    assert.equal(f.state.pieces.length, 2);
  });
  it('keeps differently measured added units separate at application', async () => {
    const f = fixture(); await add(f, 2); const item = f.state.items[0];
    await f.workflow.updateMeasurement(40, item.measurementId, { widthIn: 32 }, admin); await confirmAll(f);
    await f.workflow.submitQuote(40, {}, admin); await f.workflow.adminDecision(40, { decision: 'APPROVED' } as any, admin);
    await f.engine.applyEstimateRevision(f.state.revisions[0].id, 7, f.db);
    assert.equal(f.state.pieces.length, 3); assert.deepEqual(f.state.pieces.map((row: any) => row.qty), [1, 1, 1]);
  });
  it('rejects editing after submission and preserves the submitted snapshot', async () => {
    const f = fixture(); await add(f); await confirmAll(f); await f.workflow.submitQuote(40, {}, admin);
    const before = copy(f.state);
    await assert.rejects(() => add(f), /submitted/);
    await assert.rejects(() => f.workflow.removeAddedPiece(40, f.state.items[0].measurementId, admin), /submitted/);
    await assert.rejects(() => f.workflow.updateMeasurement(40, 20, { widthIn: 48 }, admin), /submitted/);
    assert.deepEqual(copy(f.state), before);
  });
  it('retains rejected additions and measurement changes in the next editable revision', async () => {
    const f = fixture(); await f.workflow.updateMeasurement(40, 20, { widthIn: 42 }, admin); await add(f); await confirmAll(f);
    await f.workflow.submitQuote(40, {}, admin); await f.workflow.adminDecision(40, { decision: 'REJECTED' } as any, admin);
    const old = copy(f.state.items); await add(f);
    const latest = f.state.revisions[f.state.revisions.length - 1];
    assert.equal(f.state.revisions[0].status, 'REJECTED'); assert.equal(latest.status, 'DRAFT');
    assert.equal(f.state.items.filter((row: any) => row.revisionId === latest.id).length, 3);
    assert.deepEqual(copy(f.state.items.filter((row: any) => row.revisionId !== latest.id)), old);
  });
  it('retains historical references when withdrawing an addition after rejection', async () => {
    const f = fixture(); await add(f); await confirmAll(f); await f.workflow.submitQuote(40, {}, admin);
    await f.workflow.adminDecision(40, { decision: 'REJECTED' } as any, admin);
    const removedId = f.state.items[0].measurementId; const originalRevisionId = f.state.revisions[0].id;
    await f.workflow.removeAddedPiece(40, removedId, admin);
    const visible = await f.workflow.findJob(40, admin);
    assert(!visible.measurements.some((row: any) => row.id === removedId));
    assert(f.state.measurements.some((row: any) => row.id === removedId));
    assert(f.state.items.some((row: any) => row.revisionId === originalRevisionId && row.measurementId === removedId));
  });
  for (const role of ['client', 'dealer', 'technician'] as const) it(`does not grant native remeasurement editing to ${role}`, async () => {
    const f = fixture(); await assert.rejects(() => add(f, 1, { id: 7, role: { name: role } }), /Only company staff/);
    assert.equal(f.state.items.length, 0);
  });
  it('keeps operator ownership restrictions', async () => {
    const f = fixture(); await assert.rejects(() => add(f, 1, { id: 8, role: { name: 'operator' } }), /not found/);
    await add(f, 1, { id: 7, role: { name: 'operator' } }); assert.equal(f.state.items.length, 1);
  });
  it('does not bypass the paid deposit or accepted visit', async () => {
    const f = fixture(); f.state.payments[0].status = 'PENDING'; await assert.rejects(() => add(f), /deposit must be paid/);
    f.state.payments[0].status = 'PAID'; f.state.appointments[0].status = 'PROPOSED';
    await assert.rejects(() => add(f), /accept the remeasurement schedule/);
  });
  it('keeps order changes on the existing order revision flow', async () => {
    const f = fixture(); f.state.estimate.order = { id: 9 }; await assert.rejects(() => add(f), /Revise order/);
  });
  it('does not edit an original or foreign unit through the addition endpoint', async () => {
    const f = fixture(); await add(f);
    for (const measurementId of [20, 999]) await assert.rejects(() => f.workflow.saveAddedPiece(40,
      { measurementId, piece: newPiece() }, admin), /pending added piece/);
    assert.equal(f.state.pieces[0].mark, 'ORIGINAL');
  });
  it('rejects stale quote IDs and invalid added quantities', async () => {
    const f = fixture(); await assert.rejects(() => f.workflow.saveAddedPiece(40, { quoteId: 999, piece: newPiece() }, admin), /changed/);
    for (const qty of [0, -1, 201, 1.5]) await assert.rejects(() => add(f, qty), /Quantity/);
    assert.equal(f.state.revisions.length, 0);
  });
  it('uses client pricing and ignores supplied price fields', async () => {
    const f = fixture(); f.state.estimate.user.role.name = 'client';
    const input = { ...newPiece(), price: '1', customerPrice: '1' } as any;
    await f.workflow.saveAddedPiece(40, { piece: input }, admin);
    const item = f.state.items[0]; assert.equal(item.proposedPieceInput.dealerMarkup, 0);
    assert.equal(item.proposedPieceInput.price, undefined); assert.equal(item.calculatedSnapshot.price, '225.00');
    assert.equal(item.calculatedSnapshot.customerPrice, '225.00');
  });
  it('retains the quotation if automatic installation calculation fails', async () => {
    const f = fixture(); await f.workflow.updateMeasurement(40, 20, { widthIn: 42 }, admin);
    const before = copy(f.state); f.engine.rebuildAutomaticLines = async () => { throw new Error('Mapping unavailable'); };
    await assert.rejects(() => add(f), /Mapping unavailable/); assert.deepEqual(copy(f.state), before);
  });
  it('routes admin back to the existing installation revision without exposing it to a foreign operator', async () => {
    const f = fixture(); await add(f);
    f.db.estimate.findUnique = async () => ({ ...f.estimate(), installationJob: f.job() });
    const service = new MaterialRevisionsService(f.db, f.calculator, f.workflow, {} as never, f.notifications);
    const view = await service.get(35, admin);
    assert.equal(view.installationRevisionId, 40); assert.equal(view.canBegin, false);
    const other = await service.get(35, { id: 8, role: { name: 'operator' } });
    assert.equal(other.installationRevisionId, null); assert.equal(other.installationId, null);
  });
  it('keeps the existing customer approval path and payment records for a combined revision', async () => {
    const f = fixture(); const payments = copy(f.state.payments);
    await f.workflow.updateMeasurement(40, 20, { widthIn: 42 }, admin); await add(f); await confirmAll(f);
    await f.workflow.submitQuote(40, {}, admin);
    await f.workflow.adminDecision(40, { decision: 'APPROVED' } as any, admin);
    await assert.rejects(() => f.workflow.customerDecision(40, { decision: 'APPROVED' } as any, admin), /Only the estimate owner/);
    await f.workflow.customerDecision(40, { decision: 'APPROVED' } as any, { id: 7, role: { name: 'dealer' } });
    assert.equal(f.state.pieces.length, 2); assert.equal(f.state.revisions[0].status, 'APPROVED');
    assert.equal(f.state.quotes[0].status, 'APPROVED'); assert.deepEqual(f.state.payments, payments);
    assert.equal(f.state.approvals.filter((approval: any) => approval.stage === 'CUSTOMER').length, 1);
    await assert.rejects(() => f.workflow.customerDecision(40, { decision: 'APPROVED' } as any,
      { id: 7, role: { name: 'dealer' } }), /not pending customer/);
    assert.equal(f.state.pieces.length, 2);
  });
  it('rejects the combined proposal without modifying the original pieces or deposit', async () => {
    const f = fixture(); const original = copy(f.state.pieces), payments = copy(f.state.payments);
    await add(f); await confirmAll(f); await f.workflow.submitQuote(40, {}, admin);
    await f.workflow.adminDecision(40, { decision: 'APPROVED' } as any, admin);
    await f.workflow.customerDecision(40, { decision: 'REJECTED' } as any, { id: 7, role: { name: 'dealer' } });
    assert.equal(f.state.revisions[0].status, 'REJECTED'); assert.deepEqual(f.state.pieces, original);
    assert.deepEqual(f.state.payments, payments); await add(f);
    assert.equal(f.state.items.filter((item: any) => item.revisionId === f.state.revisions[1].id && item.action === 'ADD').length, 2);
  });
  it('includes linear material in the same revision with a pending length measurement', async () => {
    const f = fixture();
    await f.workflow.saveAddedPiece(40, { piece: newPiece({ idProd: 2, height: null, width: '96' }) }, admin);
    const item = f.state.items[0], measurement = f.state.measurements.find((m: any) => m.id === item.measurementId);
    assert.equal(String(measurement.lengthIn), '96'); assert.equal(measurement.status, 'PENDING');
    await f.workflow.updateMeasurement(40, measurement.id, { lengthIn: 100 }, admin);
    assert.equal(f.state.items[0].proposedPieceInput.width, '100');
    assert.equal(f.state.items[0].action, 'ADD'); assert.equal(f.state.pieces.length, 1);
  });
  it('clears dimension fields that no longer belong to an added configuration', async () => {
    const f = fixture();
    await f.workflow.saveAddedPiece(40, { piece: newPiece({ heightLeft: '50', heightRight: '60' }) }, admin);
    const item = f.state.items[0]; await confirmAll(f);
    await f.workflow.saveAddedPiece(40, { piece: newPiece({ idConf: 2 }), measurementId: item.measurementId }, admin);
    const measurement = f.state.measurements.find((m: any) => m.id === item.measurementId);
    assert.equal(measurement.heightLeftIn, null); assert.equal(measurement.heightRightIn, null);
    assert.equal(measurement.status, 'PENDING'); assert.equal(measurement.measuredAt, null);
  });
  it('retains the separate owner addition eligibility before remeasurement starts', async () => {
    const f = fixture(); f.db.estimate.findUnique = async () => ({ ...f.estimate(), installationJob: f.job() });
    const service = new MaterialRevisionsService(f.db, f.calculator, f.workflow, {} as never, f.notifications);
    const before = await service.get(35, { id: 7, role: { name: 'dealer' } });
    assert.equal(before.canBegin, true); assert.equal(before.installationRevisionId, null);
    await f.workflow.updateMeasurement(40, 20, { widthIn: 42 }, admin);
    const after = await service.get(35, { id: 7, role: { name: 'dealer' } });
    assert.equal(after.canBegin, false); assert.equal(after.installationRevisionId, null);
  });

});
