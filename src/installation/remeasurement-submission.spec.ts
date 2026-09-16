import { Prisma } from '@prisma/client';
import { InstallationWorkflowService } from './installation-workflow.service';
import { installationQuoteContent } from './installation-quote-comparison';
import { buildPaymentSchedule } from '@/payment-plans/payment-schedule';

const dec = (v: string | number) => new Prisma.Decimal(v);
const admin: any = { id: 1, role: { name: 'admin' } };
function fixture() {
  const piece: any = {
    id: 4, idProd: 1, idBrand: 1, idSyst: 1, idConf: 1, idFC: 1, mark: 'W1', qty: 2,
    prod: { kind: 'GLAZED_UNIT' }, conf: { fixedPanelCount: 2 },
    width: dec(53), height: dec(38), panelCount: null,
    rate: dec(100), price: dec(153.41), customerPrice: dec(153.41), regularPrice: dec(153.41),
    regularCustomerPrice: dec(153.41), netProfit: dec(53.41), markup: dec(0), dealerMarkup: dec(0),
  };
  const estimate: any = { id: 22, idUser: 7, number: '190931', pieces: [piece], order: null,
    units: 2, status: { name: 'Active' }, totalPayable: '328.30' };
  const original: any = {
    id: 10, jobId: 22, version: 1, status: 'DRAFT', approvalReason: 'REMEASUREMENT',
    submittedAt: null, approvedAt: null, approvals: [], needsRecalculation: false,
    profileNameSnapshot: 'Regular', profileAdjustmentPercent: dec(0), profileMinimumSnapshot: dec(400),
    baseSubtotal: dec(500), adjustedSubtotal: dec(500), serviceMinimumAdjustment: dec(0),
    minimumAdjustment: dec(0), total: dec(500), notes: null,
    lines: [1, 2].map((i) => ({ id: i, quoteId: 10, measurementId: i, serviceId: 1,
      origin: 'AUTO', sourceSystemId: 1, sourceConfigId: 1, componentIndex: 0,
      componentLabel: 'W1', description: 'W1', billingUnitSnapshot: 'UNIT',
      rate: dec(250), billableQuantity: dec(1), occurrences: 1, widthIn: dec(53), heightIn: dec(38),
      baseAmount: dec(250), adjustedAmount: dec(250), adjustmentPercent: dec(0), sortOrder: i })),
  };
  const job: any = { id: 22, estimateId: 22, estimate, status: 'DEPOSIT_PAYMENT_PENDING',
    depositAmountSnapshot: dec(250), dealerMeasurementsAcceptedAt: null,
    payments: [], measurements: [], appointments: [], quotes: [original], revisions: [], permit: null };
  let lineId = 100;
  const latest = () => job.quotes[0];
  const revisionBy = (where: any) => job.revisions.find((r: any) => where.id ? r.id === where.id : r.quoteId === where.quoteId) ?? null;
  const tx: any = {
    installationJob: { findUnique: jest.fn(async () => job), update: jest.fn(async ({ data }) => Object.assign(job, data)) },
    installationQuote: {
      findFirst: jest.fn(async () => latest()),
      update: jest.fn(async ({ where, data }) => Object.assign(job.quotes.find((q: any) => q.id === where.id), data)),
      updateMany: jest.fn(async ({ where, data }) => {
        const q = job.quotes.find((q: any) => q.id === where.id && q.status === where.status && !q.needsRecalculation);
        if (q) Object.assign(q, data);
        return { count: q ? 1 : 0 };
      }),
      create: jest.fn(async ({ data }) => {
        const q = { ...data, id: 20, submittedAt: null, approvedAt: null, approvals: [], needsRecalculation: false,
          lines: data.lines.create.map((l: any) => ({ ...l, id: ++lineId, quoteId: 20 })) };
        job.quotes.unshift(q); return q;
      }),
      delete: jest.fn(async ({ where }) => {
        job.quotes = job.quotes.filter((q: any) => q.id !== where.id);
        job.revisions = job.revisions.filter((r: any) => r.quoteId !== where.id);
      }),
    },
    installationMeasurement: {
      findFirst: jest.fn(async ({ where }) => ({ ...job.measurements.find((m: any) => m.id === where.id), piece })),
      findMany: jest.fn(async () => job.measurements.filter((m: any) => !m.isManual)),
      count: jest.fn(async () => job.measurements.filter((m: any) => m.status === 'PENDING').length),
      update: jest.fn(async ({ where, data }) => Object.assign(job.measurements.find((m: any) => m.id === where.id), data)),
    },
    installationAppointment: { updateMany: jest.fn(async () => {
      job.appointments.forEach((a: any) => { a.status = 'COMPLETED'; }); return { count: 1 };
    }) },
    installationQuoteLine: {
      count: jest.fn(async () => latest().lines.length),
      findFirst: jest.fn(async ({ where }) => latest().lines.find((l: any) => l.id === where.id && l.quoteId === where.quoteId) ?? null),
      findMany: jest.fn(async () => latest().lines),
      delete: jest.fn(async ({ where }) => { latest().lines = latest().lines.filter((l: any) => l.id !== where.id); }),
    },
    estimateRevision: {
      findUnique: jest.fn(async ({ where }) => revisionBy(where)),
      update: jest.fn(async ({ where, data }) => Object.assign(revisionBy(where), data)),
    },
    estimateRevisionItem: { findMany: jest.fn(async ({ where }) => revisionBy({ id: where.revisionId })?.items ?? []), upsert: jest.fn(async () => ({})) },
    payment: { findFirst: jest.fn(async () => null) }, eventLog: { create: jest.fn() },
  };
  const notifications = { createAndSend: jest.fn(), createAndSendToRoles: jest.fn() };
  const calculator = { calculatePieceMetrics: jest.fn() };
  const workflow: any = new InstallationWorkflowService({} as any, {} as any, {} as any, calculator as any, {} as any, notifications as any);
  jest.spyOn(workflow, 'findJob').mockImplementation(async () => job);
  jest.spyOn(workflow, 'withAgreementJobTransaction').mockImplementation(async (_id, callback: any) => callback(tx));
  jest.spyOn(workflow, 'rebuildAutomaticLines').mockImplementation(async () => {
    for (const line of latest().lines.filter((l: any) => l.origin === 'AUTO')) {
      const m = job.measurements.find((m: any) => m.id === line.measurementId);
      line.widthIn = m.widthIn; line.heightIn = m.heightIn;
    }
  });
  jest.spyOn(workflow, 'rebuildManualLines').mockResolvedValue(null);
  jest.spyOn(workflow, 'recalculateQuoteTotals').mockResolvedValue(null);
  const ensureRevision = jest.spyOn(workflow, 'ensureDraftRevision').mockImplementation(async (_id, quote: any) => {
    let r = revisionBy({ quoteId: quote.id });
    if (!r) {
      r = { id: quote.id, quoteId: quote.id, version: quote.version, estimateId: 22, status: 'DRAFT', items: [],
        originalTotals: { units: 2, totalPayable: '328.30' }, revisedTotals: { units: 2, totalPayable: '328.30' } };
      job.revisions.push(r);
    }
    return r;
  });
  job.measurements = [1, 2].map((i) => ({ id: i, jobId: job.id, ...workflow.measurementCreateFromPiece(piece, i) }));
  // Solo se simulan los cálculos externos: comparación, envío y estados son reales.
  const upsert = jest.spyOn(workflow, 'upsertMeasuredPieceRevision').mockImplementation(async (_id, id: any, quote: any) => {
    const revision: any = await workflow.ensureDraftRevision(22, quote, 1, tx);
    revision.items = revision.items.filter((i: any) => i.measurementId !== id);
    revision.items.push({ measurementId: id, action: 'UNCHANGED' });
    return { revision, action: 'UNCHANGED' };
  });
  async function deposit() {
    await workflow.markPaymentPaid(tx, { type: 'INSTALLATION_DEPOSIT', installationJobId: 22, extraChargeId: null });
    job.payments.push({ type: 'INSTALLATION_DEPOSIT', status: 'PAID', baseAmount: '250.00', sequence: 1 });
    job.appointments.push({ type: 'REMEASUREMENT', status: 'ACCEPTED' }); job.status = 'MEASUREMENT_SCHEDULED';
  }
  async function confirm() {
    for (const m of job.measurements) await workflow.updateMeasurement(22, m.id, { label: 'New label', widthIn: 53, heightIn: 38 }, admin);
  }
  return { workflow, job, estimate, piece, original, tx, notifications, calculator, ensureRevision, upsert, deposit, confirm };
}

describe('Submitting remeasurement', () => {
  it('retains the quote and enables the first installment with the deposit credit', async () => {
    const f = fixture(); await f.deposit(); await f.confirm();
    expect(f.tx.installationQuote.create).not.toHaveBeenCalled();
    expect(f.ensureRevision).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
    await f.workflow.submitQuote(22, { notes: 'Confirmed' }, admin);
    expect(f.job.quotes).toHaveLength(1); expect(f.job.revisions).toHaveLength(0);
    expect(f.original).toMatchObject({ version: 1, status: 'APPROVED', approvals: [] });
    expect(f.job.status).toBe('MATERIAL_PAYMENT_PENDING');
    expect(f.job.measurements.every((m: any) => m.status === 'COMPLETED' && m.label === 'New label')).toBe(true);
    expect(f.tx.eventLog.create).toHaveBeenCalledTimes(1);
    const schedule = buildPaymentSchedule({ ...f.estimate, payments: f.job.payments, installationJob: f.job,
      paymentPlanSnapshot: { version: 1, name: 'test', planId: null, definition: {
        withInstallation: [{ milestone: 'ORDER', basis: 'PROJECT', percent: 50 }, { milestone: 'RELEASE', basis: 'PROJECT', percent: 40 }, { milestone: 'COMPLETE', basis: 'PROJECT', percent: 10 }],
        withoutInstallation: [{ milestone: 'ORDER', basis: 'MATERIAL', percent: 50 }, { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 }],
      } } });
    expect(schedule?.next).toMatchObject({ milestone: 'ORDER', balance: '164.15', status: 'DUE' });
    await expect(f.workflow.submitQuote(22, {}, admin)).rejects.toThrow('already ready');
    expect(f.tx.installationQuote.create).not.toHaveBeenCalled();
  });
  it('allows an empty label and a later label edit without reopening approvals', async () => {
    const f = fixture(); await f.deposit(); await f.confirm();
    await f.workflow.updateMeasurement(22, 1, { label: '' }, admin);
    expect(f.job.measurements[0].label).toBe('W1');
    await f.workflow.submitQuote(22, {}, admin);
    await f.workflow.updateMeasurement(22, 1, { label: 'Kitchen' }, admin);
    expect(f.job.status).toBe('MATERIAL_PAYMENT_PENDING'); expect(f.job.quotes).toHaveLength(1);
  });
  it('requires review for a changed measurement at the same price', async () => {
    const f = fixture(); await f.deposit(); await f.confirm();
    await f.workflow.updateMeasurement(22, 1, { widthIn: 54 }, admin);
    await f.workflow.submitQuote(22, {}, admin);
    expect(f.job.quotes).toHaveLength(2);
    expect(f.job.quotes[0]).toMatchObject({ version: 2, status: 'PENDING_ADMIN_APPROVAL', total: dec(500), needsRecalculation: false });
    expect(f.job.status).toBe('ADMIN_APPROVAL_PENDING');
    expect(f.workflow.rebuildAutomaticLines).toHaveBeenCalledTimes(1);
  });
  it('discards the unsubmitted draft when all measurements are restored', async () => {
    const f = fixture(); await f.deposit(); await f.confirm();
    await f.workflow.updateMeasurement(22, 1, { widthIn: 54 }, admin);
    await f.workflow.updateMeasurement(22, 1, { widthIn: 53 }, admin);
    await f.workflow.submitQuote(22, {}, admin);
    expect(f.original.status).toBe('APPROVED'); expect(f.job.quotes).toHaveLength(1); expect(f.job.revisions).toHaveLength(0);
  });
  it.each(['service', 'offsetting-prices', 'removed-unit', 'replacement', 'material-price', 'extra-opening'])(
    'requires review for %s despite the unchanged installation total', async (change) => {
      const f = fixture(); await f.deposit(); await f.confirm();
      const draft = await f.workflow.ensureDraftQuote(22, 1, f.tx);
      if (change === 'service') draft.lines[0].serviceId = 2;
      if (change === 'offsetting-prices') { draft.lines[0].adjustedAmount = dec(240); draft.lines[1].adjustedAmount = dec(260); }
      if (['removed-unit', 'replacement', 'material-price'].includes(change)) {
        const r: any = await f.workflow.ensureDraftRevision(22, draft, 1, f.tx); const snap = f.workflow.originalRevisionSnapshot(f.piece);
        r.items.push({ measurementId: 1, action: change === 'removed-unit' ? 'REMOVE' : 'UPDATE',
          proposedPieceInput: { ...snap.pieceInput, ...(change === 'replacement' ? { idConf: 5 } : {}) },
          calculatedSnapshot: { ...snap.pricing, ...(change === 'material-price' ? { price: '154.00' } : {}) } });
      }
      if (change === 'extra-opening') f.job.measurements.push({ id: 9, isManual: true, status: 'COMPLETED' });
      await f.workflow.submitQuote(22, {}, admin);
      expect(f.job.status).toBe('ADMIN_APPROVAL_PENDING'); expect(f.tx.installationQuote.delete).not.toHaveBeenCalled();
    });
  it('removes only an identical, never submitted draft from the old deposit flow', async () => {
    const f = fixture(); await f.deposit(); await f.confirm(); await f.workflow.ensureDraftQuote(22, 1, f.tx);
    await f.workflow.submitQuote(22, {}, admin);
    expect(f.job.quotes).toHaveLength(1); expect(f.original.status).toBe('APPROVED');
  });
  it('keeps permit processing as the next required step', async () => {
    const f = fixture(); await f.deposit(); await f.confirm(); f.job.permit = { status: 'PAYMENT_PENDING', cityFee: null };
    await f.workflow.submitQuote(22, {}, admin); expect(f.job.status).toBe('PERMIT_PAYMENT_PENDING');
  });
  it('refuses incomplete measurements and a quote already submitted', async () => {
    const f = fixture(); await f.deposit(); await expect(f.workflow.submitQuote(22, {}, admin)).rejects.toThrow();
    expect(f.original.status).toBe('SUPERSEDED'); await f.confirm();
    f.original.status = 'PENDING_ADMIN_APPROVAL'; f.original.submittedAt = new Date();
    await expect(f.workflow.submitQuote(22, {}, admin)).rejects.toThrow('not awaiting submission');
    expect(f.tx.installationQuote.delete).not.toHaveBeenCalled();
  });
  it('preserves original prices for unchanged units inside a material revision', async () => {
    const f = fixture(); f.upsert.mockRestore(); jest.spyOn(f.workflow, 'recomputeRevisionTotals').mockResolvedValue(null);
    await f.workflow.upsertMeasuredPieceRevision(22, 1, f.original, 1, f.tx);
    expect(f.calculator.calculatePieceMetrics).not.toHaveBeenCalled();
    expect(f.tx.estimateRevisionItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ action: 'UNCHANGED', calculatedSnapshot: expect.objectContaining({ price: '153.41' }) }),
    }));
  });
  it('removes a copied service while preserving the frozen original', async () => {
    const f = fixture(); await f.deposit(); f.original.lines[0].origin = 'USER_SELECTED';
    await f.workflow.removeLine(22, 1, admin);
    expect(f.original.lines).toHaveLength(2); expect(f.job.quotes[0].lines).toHaveLength(1);
  });
  it('ignores ordering and automatic Mark descriptions, but compares every service rate', () => {
    const { original } = fixture();
    const other = { ...original, lines: original.lines.map((l: any) => ({ ...l, id: l.id + 100, description: 'Kitchen' })).reverse() };
    expect(installationQuoteContent(other)).toBe(installationQuoteContent(original));
    other.lines[0].rate = dec(251); expect(installationQuoteContent(other)).not.toBe(installationQuoteContent(original));
  });
});
