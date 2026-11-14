import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import { MaterialRevisionsService } from './material-revisions.service';
import { MaterialRevisionCustomerDto, RemoveMaterialRevisionPieceDto } from './material-revision.dto';
import { materialRevisionBaseHash, revisionCustomer, revisionJson } from './material-revision-snapshot';
import { EstimatePieceCalculatorService } from '@/estimates/calculation/estimate-piece-calculator.service';
import { refreshScheduledInstallation, synchronizeScheduleChanges } from '@/payment-plans/payment-schedule';
import type { AuthUser } from '@/auth/types/auth-user.type';

jest.mock('@/payment-plans/payment-schedule', () => ({
  ...jest.requireActual('@/payment-plans/payment-schedule'),
  synchronizeScheduleChanges: jest.fn(async () => undefined),
  refreshScheduledInstallation: jest.fn(async () => undefined),
}));
jest.mock('@/contracts/agreement-content', () => ({
  ...jest.requireActual('@/contracts/agreement-content'),
  invalidateChangedAgreements: jest.fn(async () => undefined),
}));

const admin: AuthUser = { id: 1, role: { name: 'admin' } };
const owner: AuthUser = { id: 7, role: { name: 'dealer' } };

function fixture() {
  const piece = (id: number, qty: number) => ({ id, idEst: 35, qty, mark: `W${id}`, idProd: 1, idBrand: 1, idSyst: 1, idConf: 1,
    idFC: 1, width: '36', height: '48', price: '100', rate: '60', customerPrice: '125',
    regularPrice: '0', regularCustomerPrice: '0', dealerMarkup: '0.25', markup: '0.2',
    subtotal: String(qty * 100), customerSubtotal: String(qty * 125), netProfitD: String(qty * 25),
    dpPosPsf: null, dpNegPsf: null, factoryUnits: [],
    energyRatingId: 99, energySnapshot: { schemaVersion: 1, status: 'AVAILABLE', uFactor: '0.33' },
    promotionSnapshot: { id: 8, label: 'Agreed promotion' },
  });
  const estimate: any = {
    id: 35, number: '190035', name: 'Original project', idUser: 7,
    customerFirstName: 'Ana', customerLastName: 'Diaz', customerEmail: 'ana@example.test',
    customerPhone: '+13055550100', customerStreet: '100 Main St', customerAddressLine2: 'Unit 2',
    customerCity: 'Miami', customerState: 'FL', customerPostalCode: '33145',
    status: { name: 'Pending order review' }, user: { id: 7, role: { name: 'dealer' } },
    dealerModeSnapshot: 'INTERNAL', ownerMarkupSnapshot: '0.2',
    pieces: [piece(1, 2), piece(2, 1)], units: 3,
    priceT: '300', rateT: '180', customerPriceT: '375', taxRate: '0', customerTaxRate: '0',
    totalPayable: '300', customerTotalPayable: '375', taxAmount: '0', customerTaxAmount: '0',
    order: null, installationJob: null, customerCharges: [], paymentPlanSnapshot: null,
    payments: [{ id: 20, type: 'INSTALLMENT', sequence: 1, status: 'PAID', baseAmount: '250', receiptNumber: 'R20' }],
  };
  const rows: any[] = [], events: string[] = [], operations: string[] = [];
  let signed = false;
  let afterRollback: (() => void) | undefined;
  const db: any = {
    estimate: {
      findUnique: jest.fn(async () => estimate),
      findUniqueOrThrow: jest.fn(async () => estimate),
      update: jest.fn(async ({ data }) => Object.assign(estimate, data)),
    },
    piece: {
      update: jest.fn(async ({ where, data }) => {
        const next = { ...estimate.pieces.find((p: any) => p.id === where.id), ...data };
        estimate.pieces = estimate.pieces.map((p: any) => p.id === where.id ? next : p);
        operations.push(`update:${where.id}`); return next;
      }),
      deleteMany: jest.fn(async ({ where }) => {
        expect(where.idEst).toBe(35);
        const count = estimate.pieces.filter((p: any) => where.id.in.includes(p.id)).length;
        estimate.pieces = estimate.pieces.filter((p: any) => !where.id.in.includes(p.id));
        operations.push('delete'); return { count };
      }),
    },
    order: { update: jest.fn(async () => ({})) },
    materialRevision: {
      findMany: async () => rows,
      findFirst: async ({ where }: any) => rows.find(row => row.estimateId === where.estimateId &&
        (where.id == null || row.id === where.id) && (where.activeSlot == null || row.activeSlot === where.activeSlot)) ?? null,
      create: async ({ data }: any) => { const row = { id: 1, status: 'DRAFT', createdAt: new Date(), updatedAt: new Date(), ...data }; rows.push(row); return row; },
      update: async ({ where, data }: any) => Object.assign(rows.find(row => row.id === where.id), data),
    },
    estimateRevision: { findFirst: async () => null },
    estimateAgreement: {
      findFirst: async () => signed ? { id: 'signed', signedAt: new Date() } : null,
      updateMany: async () => ({ count: 0 }),
    },
    eventLog: { create: async ({ data }: any) => { events.push(data.message); return data; } },
    $queryRaw: async () => [{ id: 35 }],
  };
  db.$transaction = async (work: any) => {
    const backup = revisionJson({ estimate, rows });
    try { return await work(db); }
    catch (error) {
      Object.keys(estimate).forEach(key => delete estimate[key]); Object.assign(estimate, backup.estimate);
      rows.splice(0, rows.length, ...backup.rows);
      const hook = afterRollback; afterRollback = undefined; hook?.();
      throw error;
    }
  };
  const calculator: any = Object.create(EstimatePieceCalculatorService.prototype);
  calculator.calculatePieceMetrics = jest.fn(() => { throw new Error('Agreed quantity-only material must not query current pricing'); });
  const installation: any = {
    materialRevisionPieceInput: (p: any) => ({ ...p, dealerMarkup: Number(p.dealerMarkup) * 100 }),
    persistMaterialRevisionPiece: jest.fn(() => { throw new Error('Quantity-only must not rewrite agreed specifications'); }),
    stageMaterialRevisionInstallation: jest.fn(async (_id, changes) => { operations.push('installation'); return null; }),
  };
  const notifications: any = { createAndSend: jest.fn(async () => null), createAndSendToRoles: jest.fn(async () => null) };
  const service = new MaterialRevisionsService(db, calculator, installation, {} as any, notifications);
  const begin = () => service.begin(35, { reason: 'Correct before approving the order', factoryNotSentConfirmed: true }, admin);
  const approve = async () => { await service.submit(35, 1, true, admin); return service.decide(35, 1, { decision: 'APPROVE', accepted: true }, owner); };
  return { service, db, estimate, rows, events, operations, calculator, installation, begin, approve,
    setSigned: () => { signed = true; }, afterRollback: (fn: () => void) => { afterRollback = fn; } };
}

beforeEach(() => jest.clearAllMocks());

describe('Protected pre-order corrections use the existing revision', () => {
  it.each([1, 3])('proposes quantity %s, preserves every historical unit field and applies only after approval', async qty => {
    const f = fixture(); f.estimate.pieces[0].regularPrice = new Prisma.Decimal(0);
    f.estimate.pieces[0].regularCustomerPrice = new Prisma.Decimal(0);
    await f.begin(); const before = revisionJson(f.estimate), original = before.pieces[0];
    const saved = await f.service.savePiece(35, 1, { originalPieceId: 1, piece: { ...original, qty } }, admin);
    expect(revisionJson(f.estimate)).toEqual(before);
    expect(saved.current!.items[0].changeDescription).toContain(`Quantity: 2 → ${qty}`);
    expect(f.rows[0].proposal.totals.discountAmount).toBe('0');
    expect(f.rows[0].proposal.totals.originalPriceT).toBe(String((qty + 1) * 100));
    await f.approve();
    const changed = f.estimate.pieces[0];
    expect(changed.qty).toBe(qty); expect(String(changed.subtotal)).toBe(String(qty * 100));
    for (const key of ['id', 'price', 'rate', 'customerPrice', 'regularPrice', 'regularCustomerPrice', 'dpPosPsf', 'dpNegPsf', 'promotionSnapshot', 'energySnapshot'])
      expect(revisionJson(changed[key])).toEqual(original[key]);
    expect(f.estimate.payments).toEqual(before.payments); expect(f.estimate.order).toBeNull();
    expect(f.estimate.status.name).toBe('Pending order review');
    expect(f.calculator.calculatePieceMetrics).not.toHaveBeenCalled();
    expect(f.installation.persistMaterialRevisionPiece).not.toHaveBeenCalled();
  });

  it('allows a mark-only correction without rejecting it as unchanged', async () => {
    const f = fixture(); await f.begin();
    const result = await f.service.savePiece(35, 1, { originalPieceId: 1, piece: { ...f.estimate.pieces[0], mark: 'Bedroom' } }, admin);
    expect(result.current!.items[0].changeDescription).toContain('Mark: W1 → Bedroom');
    expect(f.estimate.pieces[0].mark).toBe('W1');
  });

  it('proposes/removes/restores an original piece while preserving its complete audit snapshot and payments', async () => {
    const f = fixture(); await f.begin(); const before = revisionJson(f.estimate);
    let result = await f.service.removePiece(35, 1, 1, admin);
    expect(revisionJson(f.estimate)).toEqual(before);
    const item = f.rows[0].items[0]; expect(item.original).toEqual(before.pieces[0]);
    expect(result.current!.items[0].action).toBe('REMOVE'); expect(result.current!.items[0].subtotal).toBe('0.00');
    expect(f.rows[0].proposal.pieces.map((p: any) => p.id)).toEqual([2]);
    await f.service.removeItem(35, 1, item.key, admin);
    expect(f.rows[0].items).toEqual([]); expect(f.rows[0].proposal.pieces).toHaveLength(2);
    result = await f.service.removePiece(35, 1, 1, admin);
    f.operations.splice(0); await f.approve();
    expect(f.operations).toEqual(['installation', 'delete']);
    expect(f.estimate.pieces.map((p: any) => p.id)).toEqual([2]); expect(f.estimate.units).toBe(1);
    expect(f.estimate.payments).toEqual(before.payments); expect(f.rows[0].status).toBe('APPLIED');
    expect(f.rows[0].revisedSummary.creditBalance).toBe('125.00');
  });

  it('submits and applies customer-only corrections with no financial, installation or payment-plan writes', async () => {
    const f = fixture(); f.estimate.status.name = 'Ordered';
    f.estimate.order = { id: 8, number: 'O8', status: { name: 'Pending' }, poNumber: null, rateReal: null, amount: '375' };
    await f.begin(); const before = revisionJson(f.estimate);
    const result = await f.service.saveCustomer(35, 1, { name: 'Corrected project', firstName: 'Anna', addressLine2: '' }, admin);
    expect(revisionJson(f.estimate)).toEqual(before);
    expect(result.currentCustomer.firstName).toBe('Ana'); expect(result.customer.firstName).toBe('Anna');
    expect(result.current!.originalCustomer?.addressLine2).toBe('Unit 2');
    expect(f.rows[0].proposal.totals).toEqual({}); expect(f.rows[0].items).toEqual([]);
    await f.approve();
    expect(f.estimate.customerFirstName).toBe('Anna'); expect(f.estimate.name).toBe('Corrected project');
    expect(f.estimate.customerAddressLine2).toBeNull();
    expect(f.estimate.pieces).toEqual(before.pieces); expect(f.estimate.payments).toEqual(before.payments);
    expect(f.db.order.update).not.toHaveBeenCalled(); expect(f.db.piece.update).not.toHaveBeenCalled();
    expect(f.installation.stageMaterialRevisionInstallation).not.toHaveBeenCalled();
    expect(synchronizeScheduleChanges).not.toHaveBeenCalled(); expect(refreshScheduledInstallation).not.toHaveBeenCalled();
  });

  it('requires the replacement signature for a customer-only revision when a signed agreement exists', async () => {
    const f = fixture(); f.setSigned(); await f.begin();
    await f.service.saveCustomer(35, 1, { firstName: 'Anna' }, admin); await f.approve();
    expect(f.rows[0].status).toBe('AWAITING_SIGNATURE'); expect(f.estimate.customerFirstName).toBe('Ana');
  });

  it.each(['REJECT', 'CANCEL'] as const)('%s preserves live data, payments and pieces', async decision => {
    const f = fixture(); await f.begin(); const before = revisionJson(f.estimate);
    await f.service.saveCustomer(35, 1, { firstName: 'Anna' }, admin);
    await f.service.removePiece(35, 1, 1, admin);
    if (decision === 'REJECT') await f.service.submit(35, 1, true, admin);
    await f.service.decide(35, 1, { decision }, owner);
    expect(revisionJson(f.estimate)).toEqual(before); expect(f.rows[0].activeSlot).toBeNull();
  });

  it('retains a customer correction when a piece change is saved then discarded', async () => {
    const f = fixture(); await f.begin(); await f.service.saveCustomer(35, 1, { firstName: 'Anna' }, admin);
    const result = await f.service.savePiece(35, 1, { originalPieceId: 1, piece: { ...f.estimate.pieces[0], qty: 1 } }, admin);
    await f.service.removeItem(35, 1, result.current!.items[0].key, admin);
    expect(f.rows[0].proposal.customer.firstName).toBe('Anna'); expect(f.rows[0].items).toEqual([]);
    await f.service.submit(35, 1, true, admin); expect(f.rows[0].status).toBe('PENDING_APPROVAL');
  });

  it('permits an empty draft for replacement but blocks submission and application with zero units', async () => {
    const f = fixture(); await f.begin(); await f.service.removePiece(35, 1, 1, admin); await f.service.removePiece(35, 1, 2, admin);
    expect(f.rows[0].proposal.totals.units).toBe(0); expect(f.estimate.pieces).toHaveLength(2);
    await expect(f.service.submit(35, 1, true, admin)).rejects.toThrow(/at least one unit/);
    f.rows[0].approvedAt = new Date();
    await expect((f.service as any).apply(f.db, f.estimate, f.rows[0], 7)).rejects.toThrow(/at least one unit/);
    expect(f.estimate.pieces).toHaveLength(2);
  });

  it('does not expand the owner permissions or allow pieces from another estimate', async () => {
    const f = fixture(); await f.begin();
    const view = await f.service.get(35, owner);
    expect([view.canEditCustomer, view.canRemovePieces, view.canChangeQuantity]).toEqual([false, false, false]);
    await expect(f.service.saveCustomer(35, 1, { firstName: 'Anna' }, owner)).rejects.toThrow(/authorized/);
    await expect(f.service.removePiece(35, 1, 1, owner)).rejects.toThrow(/authorized/);
    await expect(f.service.removePiece(35, 1, 999, admin)).rejects.toThrow(/not found/);
    expect(f.rows[0].items).toEqual([]);
  });

  it('rejects changed customer baselines and concurrent proposal edits even at the same timestamp', async () => {
    const f = fixture(); await f.begin();
    f.afterRollback(() => { f.rows[0].proposal = { customer: { ...revisionCustomer(f.estimate), firstName: 'Concurrent' } }; });
    await expect(f.service.saveCustomer(35, 1, { firstName: 'Anna' }, admin)).rejects.toThrow(/Another user/);
    expect(f.rows[0].proposal.customer.firstName).toBe('Concurrent');
    f.estimate.customerEmail = 'different@example.test';
    await expect(f.service.saveCustomer(35, 1, { firstName: 'Anna' }, admin)).rejects.toThrow(/project changed/);
  });

  it('clears a reverted customer proposal and does not submit a no-op', async () => {
    const f = fixture(); await f.begin(); await f.service.saveCustomer(35, 1, { firstName: 'Anna' }, admin);
    await f.service.saveCustomer(35, 1, { firstName: 'Ana' }, admin);
    expect(f.rows[0].proposal.customer).toBeUndefined();
    await expect(f.service.submit(35, 1, true, admin)).rejects.toThrow(/at least one change/);
    expect(materialRevisionBaseHash(f.estimate)).toBe(f.rows[0].baseHash);
  });
});

describe('Correction DTO boundaries', () => {
  it('normalizes existing customer formats and permits clearing optional fields', async () => {
    const dto = plainToInstance(MaterialRevisionCustomerDto, { firstName: ' Ana ', email: 'ANA@EXAMPLE.TEST', state: 'fl', postalCode: '33145', addressLine2: '', phone: '(305) 555-0100' });
    expect(await validate(dto)).toEqual([]); expect(dto.firstName).toBe('Ana'); expect(dto.email).toBe('ana@example.test');
    expect(dto.addressLine2).toBeNull(); expect(dto.phone).toBe('+13055550100');
  });
  it.each([{ name: '' }, { name: null }, { email: 'invalid' }, { phone: '123' }, { state: 'ZZ' }, { postalCode: 'x' }, { customerTaxRate: 1 }, { idUser: 10 }])('rejects invalid or unauthorized fields %j', async payload => {
    const dto = plainToInstance(MaterialRevisionCustomerDto, payload);
    expect((await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).length).toBeGreaterThan(0);
  });
  it.each([0, -1, 1.5, '1', null])('rejects invalid removal ID %j', async originalPieceId => {
    expect((await validate(plainToInstance(RemoveMaterialRevisionPieceDto, { originalPieceId }))).length).toBeGreaterThan(0);
  });
});
