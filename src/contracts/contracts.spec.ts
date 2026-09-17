import { agreementQuoteReport, changeOrderHtml } from './contract-pdf.service';
import { PaymentsService } from '@/payments/payments.service';
import { PaymentType, Prisma } from '@prisma/client';
import { getAgreementPaymentRequirement, requireSignedAgreementForPayment } from './agreement-payment';
import { EstimatePdfHtmlBuilder } from '@/estimates/pdf/estimate-pdf-html.builder';
import { randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PDFDocument } from 'pdf-lib';
import { ContractsService } from './contracts.service';
import { ContractStorageService } from './contract-storage.service';
import {
  agreementContent,
  canonicalJson,
  invalidateChangedAgreements,
  loadAgreementContent,
  sha256,
  withAgreementTransaction,
} from './agreement-content';
import { buildPublicEstimateData } from '@/estimates/public-share/public-estimate-data';
import { defaultPlan } from '@/payment-plans/payment-plan';

jest.mock('@/estimates/reporting/estimate-piece-diagram-metadata', () => ({
  attachEstimatePieceDiagramMetadata: async (_db: unknown, pieces: unknown[]) =>
    pieces,
}));
const dealer = { id: 7, role: { name: 'dealer' as const } };
const token = 'f4318ac1-ae5f-4acd-b026-1420d033405c';
const strokes = [
  [
    { x: 0.1, y: 0.6 },
    { x: 0.2, y: 0.2 },
    { x: 0.3, y: 0.7 },
    { x: 0.4, y: 0.3 },
    { x: 0.5, y: 0.5 },
  ],
];

export function contractEstimateFixture(): any {
  return {
    id: 1,
    idUser: 7,
    number: '190001',
    name: 'Test project',
    date: new Date('2026-09-13T12:00:00Z'),
    expiresAt: new Date('2099-10-13T12:00:00Z'),
    publicToken: token,
    publicTotalToken: `total_${token}`,
    publicTokenEnabled: true,
    user: {
      id: 7,
      isActive: true,
      role: { name: 'dealer' },
      dealerMode: 'EXTERNAL',
    },
    status: { name: 'Active' },
    order: null,
    payments: [],
    dealerModeSnapshot: 'EXTERNAL',
    agreementRevision: 0,
    rateT: '600.00',
    priceT: '800.00',
    netProfit: '200.00',
    taxRate: '.07',
    taxAmount: '56.00',
    totalPayable: '856.00',
    customerPriceT: '1000.00',
    customerTaxRate: '.07',
    customerTaxAmount: '70.00',
    customerTotalPayable: '1070.00',
    customerFirstName: 'Jane',
    customerLastName: 'Rivera',
    customerEmail: 'jane@example.test',
    customerPhone: '+13055550111',
    customerStreet: '123 Example Street',
    customerCity: 'Miami',
    customerState: 'FL',
    customerPostalCode: '33101',
    installationJob: null,
    customerCharges: [],
    manualDiscount: null,
    pieces: [
      {
        id: 2,
        mark: 'W1',
        qty: 1,
        width: 48,
        height: 60,
        highBottom: false,
        screen: false,
        idProd: 1,
        idBrand: 1,
        idSyst: 1,
        idConf: 1,
        idFC: 1,
        idCryst: 1,
        idTint: 1,
        idCoat: 1,
        idPrivacy: 1,
        prod: { id: 1, name: 'Window' },
        bran: { id: 1, name: 'Example' },
        syst: { id: 1, name: 'Series A' },
        conf: { id: 1, conf: 'Fixed' },
        fColor: { id: 1, color: 'White' },
        cryst: { id: 1, glass: 'Clear laminated' },
        tin: { id: 1, color: 'Clear' },
        coat: { id: 1, name: 'None' },
        privacyOption: { id: 1, name: 'None' },
        activeOption: { id: 1, name: 'None' },
        preparationOption: { id: 1, name: 'None' },
        sillOption: { id: 1, name: 'Standard' },
        reinforcementOption: { id: 1, name: 'None' },
        rate: '600',
        price: '800',
        netProfit: '200',
        customerPrice: '1000.00',
        customerSubtotal: '1000.00',
        pieceMuntin: null,
      },
    ],
  };
}

function contentHash(estimate: any) {
  return sha256(
    canonicalJson(
      agreementContent(
        JSON.parse(
          JSON.stringify(
            buildPublicEstimateData(
              estimate,
              null,
              estimate.pieces,
              'detailed',
            ),
          ),
        ),
      ),
    ),
  );
}

describe('Contract content policy', () => {
  it('shows company payment terms to internal dealer customers without exposing them to external dealer customers', () => {
    const e = contractEstimateFixture();
    e.paymentPlanSnapshot = {version:1, planId:1, name:'Material upfront', definition:defaultPlan};
    const external = buildPublicEstimateData(e, null, e.pieces, 'detailed');
    expect(external).not.toHaveProperty('paymentSchedule');
    expect(external).not.toHaveProperty('paymentPlanTerms');
    e.dealerModeSnapshot = 'INTERNAL';e.user.dealerMode = 'INTERNAL';
    const internal = buildPublicEstimateData(e, null, e.pieces, 'detailed');
    expect(internal.paymentSchedule?.total).toBe('1070.00');
    const html = EstimatePdfHtmlBuilder.build(agreementQuoteReport(internal), 'dealer_public');
    expect(html).toContain('Payment Schedule');expect(html).toContain('Place order');
    const signed = contentHash(e);
    e.payments = [{type:'INSTALLMENT', status:'PAID', sequence:1, baseAmount:'1070.00'}];
    e.order = {id:20, status:{name:'Ready to pick up'}};
    expect(contentHash(e)).toBe(signed);
    e.paymentPlanSnapshot = {...e.paymentPlanSnapshot, definition:{...defaultPlan,withoutInstallation:[{milestone:'ORDER',basis:'MATERIAL',percent:50},{milestone:'RELEASE',basis:'MATERIAL',percent:50}]}};
    expect(contentHash(e)).not.toBe(signed);
  });

  it.each(['detailed', 'total'] as const)(
    'renders the %s saved quote using only its public snapshot',
    (mode) => {
      const e = contractEstimateFixture();
      const snapshot = JSON.parse(
        JSON.stringify(
          buildPublicEstimateData(e, { name: 'Dealer Co.' }, e.pieces, mode),
        ),
      );
      const html = EstimatePdfHtmlBuilder.build(
        agreementQuoteReport(snapshot),
        mode === 'total' ? 'dealer_public_total' : 'dealer_public',
      );
      expect(html).toContain('$1,070.00');
      expect(html).not.toContain('$600.00');
      expect(html).not.toContain('$800.00');
      if (mode === 'total') expect(html).not.toContain('$1,000.00');
    },
  );

  it('keeps acceptance after a Mark edit, payment, status update, internal cost or profit change', () => {
    const estimate = contractEstimateFixture();
    const original = contentHash(estimate);
    estimate.pieces[0].mark = 'Changed identifier';
    estimate.pieces[0].rate = '1';
    estimate.rateT = '1';
    estimate.netProfit = '999';
    estimate.status = { name: 'Ordered' };
    estimate.order = { id: 100 };
    estimate.payments = [{ status: 'PAID' }];
    expect(contentHash(estimate)).toBe(original);
  });
  it.each([
    'width',
    'height',
    'heightLeft',
    'heightRight',
    'legHeight',
    'sashHeight',
    'windowHeight',
    'doorWidth',
    'doorHeight',
    'leftSideliteWidth',
    'rightSideliteWidth',
    'leftPanels',
    'rightPanels',
    'panelCount',
    'highBottomPercent',
    'dpPosPsf',
    'dpNegPsf',
    'qty',
    'idProd',
    'idBrand',
    'idSyst',
    'idConf',
    'idFC',
    'idCryst',
    'idTint',
    'idCoat',
    'idPrivacy',
  ])('requires a new acceptance for %s even at the same price', (key) => {
    const estimate = contractEstimateFixture();
    const original = contentHash(estimate);
    estimate.pieces[0][key] = 99;
    expect(contentHash(estimate)).not.toBe(original);
  });
  it.each([
    'activeOption',
    'preparationOption',
    'sillOption',
    'reinforcementOption',
  ])('tracks %s selections', (key) => {
    const estimate = contractEstimateFixture();
    const original = contentHash(estimate);
    estimate.pieces[0][key].id = 2;
    expect(contentHash(estimate)).not.toBe(original);
  });
  it('tracks screen, grid, horizontal divisions, prices, contact and expiration', () => {
    for (const change of [
      (e: any) => (e.pieces[0].screen = true),
      (e: any) => (e.pieces[0].horizontalHeights = [20, 40]),
      (e: any) => (e.pieces[0].customerPrice = '1001'),
      (e: any) => (e.customerEmail = 'other@example.test'),
      (e: any) => (e.expiresAt = new Date('2099-11-13')),
    ]) {
      const estimate = contractEstimateFixture();
      const original = contentHash(estimate);
      change(estimate);
      expect(contentHash(estimate)).not.toBe(original);
    }
  });
  it('ignores dealer cost changes hidden behind a fixed customer installation price', () => {
    const e = contractEstimateFixture();
    e.installationJob = {
      status: 'DEPOSIT_PAYMENT_PENDING',
      quotes: [
        {
          status: 'DRAFT',
          total: '2000',
          lines: [],
          serviceMinimumsSnapshot: [],
        },
      ],
      permit: null,
    };
    e.customerCharges = [
      {
        id: 1,
        origin: 'SYSTEM',
        source: 'INSTALLATION',
        sourceKey: 'INSTALLATION',
        sourceRefId: null,
        description: 'Installation',
        pricingMode: 'FINAL',
        pricingValue: '3000',
        usedInCustomerQuote: true,
        sortOrder: 10,
      },
    ];
    const original = contentHash(e);
    e.installationJob.quotes[0].total = '2100';
    expect(contentHash(e)).toBe(original);
    e.customerCharges[0].pricingValue = '3001';
    expect(contentHash(e)).not.toBe(original);
  });
  it('hides all customer price breakdown in the total snapshot and all dealer costs in both views', () => {
    const e = contractEstimateFixture();
    for (const mode of ['detailed', 'total'] as const) {
      const p = buildPublicEstimateData(e, null, e.pieces, mode);
      expect(p).not.toHaveProperty('rateT');
      expect(p.pieces[0]).not.toHaveProperty('rate');
      expect(p).not.toHaveProperty('netProfit');
      if (mode === 'total') {
        expect(p.customerPriceT).toBe(0);
        expect(p.pieces[0].customerPrice).toBe(0);
        expect(p.publicProjectTotal).toBe(1070);
      }
    }
  });
});

// Doble transaccional con rollback y exclusión mutua; las pruebas ejercitan el servicio completo sin una base de datos real.
function databaseFixture() {
  let state: any = {
    estimate: [contractEstimateFixture()],
    dealerContract: [],
    estimateAgreement: [],
    eventLog: [],
    branding: [],
  };
  function matches(row: any, where: any = {}): boolean {
    return Object.entries(where).every(([key, value]: [string, any]) => {
      if (key === 'OR')
        return value.some((clause: any) => matches(row, clause));
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        if ('in' in value) return value.in.includes(row[key]);
        if ('not' in value) return row[key] !== value.not;
      }
      return row?.[key] === value;
    });
  }
  const db: any = { $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]) };
  for (const model of Object.keys(state)) {
    const rows = (args: any = {}) => {
      let found = state[model].filter((row: any) => matches(row, args.where));
      const order = args.orderBy;
      if (order && !Array.isArray(order)) {
        const key = Object.keys(order)[0];
        found = [...found].sort(
          (a: any, b: any) =>
            (a[key] > b[key] ? 1 : -1) * (order[key] === 'desc' ? -1 : 1),
        );
      }
      return found.map((row: any) => {
        const result = { ...row };
        if (args.include?.contract || args.select?.contract)
          result.contract = state.dealerContract.find(
            (c: any) => c.id === row.contractId,
          );
        // Respetar select permite detectar dependencias de campos que Prisma no devuelve.
        return structuredClone(
          args.select
            ? Object.fromEntries(
                Object.entries(args.select)
                  .filter(([, selected]) => selected)
                  .map(([key]) => [key, result[key]]),
              )
            : result,
        );
      });
    };
    const update = (row: any, data: any) => {
      for (const [key, value] of Object.entries(data))
        row[key] =
          value && typeof value === 'object' && 'increment' in value
            ? (row[key] ?? 0) + value.increment
            : value;
    };
    db[model] = {
      findUnique: jest.fn(async (args: any) => rows(args)[0] ?? null),
      findFirst: jest.fn(async (args: any) => rows(args)[0] ?? null),
      findMany: jest.fn(async (args: any) => rows(args)),
      create: jest.fn(async (args: any) => {
        const row = {
          isCurrent: true,
          signedAt: null,
          invalidatedAt: null,
          quoteFileKey: null,
          createdAt: new Date(),
          ...args.data,
        };
        state[model].push(row);
        return rows({
          where: { id: row.id },
          include: args.include,
          select: args.select,
        })[0];
      }),
      update: jest.fn(async (args: any) => {
        const row = state[model].find((r: any) => matches(r, args.where));
        update(row, args.data);
        return rows({
          where: args.where,
          include: args.include,
          select: args.select,
        })[0];
      }),
      updateMany: jest.fn(async (args: any) => {
        const found = state[model].filter((r: any) => matches(r, args.where));
        found.forEach((r: any) => update(r, args.data));
        return { count: found.length };
      }),
      deleteMany: jest.fn(async (args: any) => {
        state[model] = state[model].filter((r: any) => !matches(r, args.where));
      }),
    };
  }
  let tail = Promise.resolve();
  db.$transaction = jest.fn((work: any) => {
    const result = tail.then(async () => {
      const before = structuredClone(state);
      try {
        return await work(db);
      } catch (error) {
        state = before;
        throw error;
      }
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  });
  return { db, state: () => state };
}

describe('Agreement acceptance, access and history', () => {
  let dir: string,
    f: ReturnType<typeof databaseFixture>,
    storage: ContractStorageService,
    service: ContractsService,
    pdf: any,
    quote: Buffer;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'contract-test-'));
    process.env.CONTRACT_STORAGE_DIR = dir;
    f = databaseFixture();
    storage = new ContractStorageService();
    const doc = await PDFDocument.create();
    doc.addPage();
    quote = Buffer.from(await doc.save());
    pdf = {
      quote: jest.fn(async () => quote),
      changeOrder: jest.fn(async () => quote),
      receipt: jest.fn(async () => quote),
    };
    service = new ContractsService(f.db, storage, pdf);
    await service.upload(dealer, {
      buffer: quote,
      originalname: 'Contract.pdf',
    } as any);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.CONTRACT_STORAGE_DIR;
  });
  async function ready(mode: 'detailed' | 'total' = 'detailed') {
    return (await service.prepare(1, mode, false, dealer)).current!;
  }
  const input = (a: any) => ({
    contentHash: a.contentHash,
    signerName: 'Jane Rivera',
    signature: strokes,
    accepted: true,
  });

  function paymentHarness(type: PaymentType = PaymentType.MATERIAL, amount = 1370) {
    f.db.payment = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 42 }),
      update: jest.fn().mockResolvedValue({}),
    };
    const context = () => ({
      estimate: f.state().estimate[0],
      job: f.state().estimate[0].installationJob,
      paymentSequence: 1,
      description: 'Customer payment',
      baseAmount: new Prisma.Decimal(amount),
      surchargePercent: new Prisma.Decimal(0),
      surchargeAmount: new Prisma.Decimal(0),
      totalAmount: new Prisma.Decimal(amount),
    });
    const workflow = { getPaymentContext: jest.fn(async (..._args: unknown[]) => context()) };
    const payments = new PaymentsService(f.db, {
      get: (key: string) => key === 'STRIPE_SECRET_KEY' ? 'sk_test_local' : 'http://localhost:3000',
    } as any, workflow as any, {} as any);
    // Un contexto visto antes de la firma no puede decidir la autorización del POST.
    jest.spyOn(payments, 'getPublicPaymentContext').mockResolvedValue({
      enabled: true, payment: { type, sequence: 1 },
    } as any);
    const create = jest.fn().mockResolvedValue({ id: 'cs_test', url: 'https://checkout.stripe.com/test' });
    const retrieve = jest.fn().mockResolvedValue({
      id: 'cs_open', status: 'open', payment_status: 'unpaid', url: 'https://checkout.stripe.com/open',
    });
    (payments as any).stripe = { checkout: { sessions: { create, retrieve } } };
    return { payments, create, retrieve, workflow, context };
  }

  it('stores duplicate uploads once and reuses a prepared agreement', async () => {
    await service.upload(dealer, {
      buffer: quote,
      originalname: 'Same contract.pdf',
    } as any);
    expect(f.state().dealerContract).toHaveLength(1);
    const first = await ready();
    const second = await ready();
    expect(second.id).toBe(first.id);
    expect(pdf.quote).toHaveBeenCalledTimes(1);
  });
  it('records a direct signature and returns a combined estimate, contract and receipt', async () => {
    const a = await ready();
    const result = await service.sign(token, a.id, input(a), {
      ip: '127.0.0.1',
    });
    expect(result.current!.state).toBe('SIGNED');
    expect(
      (
        await PDFDocument.load(
          await service.publicDocument(token, a.id, 'signed'),
        )
      ).getPageCount(),
    ).toBe(3);
  });
  it('returns identical signed PDF bytes on later downloads', async () => {
    const agreement = await ready();
    await service.sign(token, agreement.id, input(agreement), {});
    const original = await service.publicDocument(
      token,
      agreement.id,
      'signed',
    );
    const signedAt = f.state().estimateAgreement[0].signedAt;
    try {
      jest.useFakeTimers({ now: new Date('2030-01-01T00:00:00Z') });
      const downloaded = await service.publicDocument(
        token,
        agreement.id,
        'signed',
      );
      expect(downloaded).toEqual(original);
      const document = await PDFDocument.load(downloaded, {
        updateMetadata: false,
      });
      expect(document.getCreationDate()?.getTime()).toBe(
        Math.floor(signedAt.getTime() / 1000) * 1000,
      );
    } finally {
      jest.useRealTimers();
    }
  });
  it.each(['detailed', 'total'] as const)(
    'prepares and signs a new %s revision after a service change without sorting saved JSON',
    async (mode) => {
      const publicToken = mode === 'total' ? `total_${token}` : token;
      const first = await ready(mode);
      const firstRow = f.state().estimateAgreement[0];
      // Representa un logo incorporado grande dentro de la copia histórica.
      firstRow.snapshot.branding = {
        logoUrl: `data:image/png;base64,${'A'.repeat(1024 * 1024)}`,
      };
      await service.sign(publicToken, first.id, input(first), {});
      const savedSnapshot = structuredClone(firstRow.snapshot);
      const receiptKey = firstRow.receiptFileKey;
      const receiptBytes = await storage.read(receiptKey);

      f.state().estimate[0].installationJob = {
        status: 'REQUESTED',
        quotes: [{ status: 'DRAFT', total: '1000.00', lines: [] }],
        permit: { permitFeeSnapshot: '1500.00', cityFee: null },
      };
      const next = (await service.prepare(1, mode, true, dealer)).current!;
      expect(next.id).not.toBe(first.id);
      expect(next.revision).toBe(first.revision + 1);
      expect(next.state).toBe('AWAITING_SIGNATURE');
      expect((await service.prepare(1, mode, true, dealer)).current!.id).toBe(
        next.id,
      );
      expect(pdf.quote).toHaveBeenCalledTimes(1);
      expect(pdf.changeOrder).toHaveBeenCalledTimes(1);
      expect(next.kind).toBe('CHANGE_ORDER');
      const snapshot = await service.publicSnapshot(publicToken, next.id);
      expect(snapshot).toHaveProperty(
        'customerChargesSummary.customerTotalIncomplete',
        true,
      );
      expect(snapshot).toHaveProperty('customerChargesSummary.lines.length', 3);
      if (mode === 'total')
        expect(snapshot).toHaveProperty('publicProjectTotal', 3570);
      else
        expect(snapshot).toHaveProperty(
          'customerChargesSummary.customerTotal',
          '2500.00',
        );

      const signed = await service.sign(publicToken, next.id, input(next), {});
      expect(signed.current!.state).toBe('SIGNED');
      const info = await service.estimateInfo(1, mode, dealer);
      expect(info.current!.id).toBe(next.id);
      expect(info.history.map((item) => item!.id)).toEqual([next.id, first.id]);
      expect(
        (await service.publicInfo(publicToken, first.id)).current!.state,
      ).toBe('REQUIRES_NEW_SIGNATURE');
      expect(
        (await service.publicInfo(publicToken, next.id)).current!.state,
      ).toBe('SIGNED');
      expect(await service.publicSnapshot(publicToken, first.id)).toEqual(
        savedSnapshot,
      );
      expect(firstRow.receiptFileKey).toBe(receiptKey);
      expect(await storage.read(receiptKey)).toEqual(receiptBytes);
      expect(
        (
          await PDFDocument.load(
            await service.publicDocument(publicToken, first.id, 'signed'),
          )
        ).getPageCount(),
      ).toBe(3);

      const orderedReads = [
        ...f.db.estimateAgreement.findFirst.mock.calls,
        ...f.db.estimateAgreement.findMany.mock.calls,
      ]
        .map(([args]) => args)
        .filter((args) => args.orderBy);
      expect(orderedReads.length).toBeGreaterThan(0);
      // Regresión del error MySQL 1038: ordenar metadatos no debe cargar las columnas JSON.
      for (const args of orderedReads) {
        expect(args.select).toBeDefined();
        expect(args.select).not.toHaveProperty('snapshot', true);
        expect(args.select).not.toHaveProperty('signature', true);
        expect(args.select).not.toHaveProperty('chargesSnapshot', true);
      }
    },
  );
  it.each(['detailed', 'total'] as const)(
    'requires complete customer details before preparing a %s contract link',
    async (mode) => {
      const e = f.state().estimate[0];
      e.customerEmail = null;
      e.customerPhone = null;
      e.customerStreet = '   ';
      await expect(ready(mode)).rejects.toThrow(
        'Complete the customer details in the estimate before sharing with a contract. Missing: Email, Phone, Street address.',
      );
      expect(f.state().estimateAgreement).toHaveLength(0);
      expect(pdf.quote).not.toHaveBeenCalled();
      // El doble transaccional restaura su estado al rechazar la preparación.
      const completed = f.state().estimate[0];
      completed.customerEmail = 'customer@example.test';
      completed.customerPhone = '+13055550111';
      completed.customerStreet = '123 Example Street';
      const a = await ready(mode);
      const publicToken = mode === 'total' ? `total_${token}` : token;
      await service.sign(publicToken, a.id, input(a), {});
      completed.customerLastName = 'Updated';
      expect((await service.publicInfo(publicToken, a.id)).current.state).toBe(
        'REQUIRES_NEW_SIGNATURE',
      );
    },
  );
  it('requires the agreement ID and keeps separate contract links pinned to their documents', async () => {
    const a = await ready();
    await service.sign(token, a.id, input(a), {});
    f.state().estimate[0].pieces[0].width = 50;
    const newer = await ready();
    expect((await service.publicInfo(token, a.id)).current!.id).toBe(a.id);
    expect((await service.publicInfo(token, newer.id)).current!.id).toBe(
      newer.id,
    );
    expect((await service.publicInfo(token, newer.id)).history).toEqual([]);
    await expect(service.publicInfo(token, '')).rejects.toThrow('not found');
    await expect(service.publicInfo(token, 'unknown')).rejects.toThrow(
      'not found',
    );
    await expect(service.publicInfo('total_' + token, a.id)).rejects.toThrow(
      'not found',
    );
  });
  it('does not accept stale content even when the customer loaded an older page', async () => {
    const a = await ready();
    f.state().estimate[0].pieces[0].width = 50;
    await expect(service.sign(token, a.id, input(a), {})).rejects.toThrow(
      'changed',
    );
    expect(pdf.receipt).not.toHaveBeenCalled();
  });
  it('keeps Mark edits signed, invalidates a configuration edit permanently and preserves the download', async () => {
    const a = await ready();
    await service.sign(token, a.id, input(a), {});
    f.state().estimate[0].pieces[0].mark = 'W99';
    await invalidateChangedAgreements(f.db, 1);
    expect(f.state().estimateAgreement[0].invalidatedAt).toBeNull();
    await withAgreementTransaction(f.db, 1, async () => {
      f.state().estimate[0].pieces[0].width = 50;
    });
    await withAgreementTransaction(f.db, 1, async () => {
      f.state().estimate[0].pieces[0].width = 48;
    });
    expect((await service.publicInfo(token, a.id)).current!.state).toBe(
      'REQUIRES_NEW_SIGNATURE',
    );
    expect(
      (
        await PDFDocument.load(
          await service.publicDocument(token, a.id, 'signed'),
        )
      ).getPageCount(),
    ).toBe(3);
  });
  it('serializes simultaneous submissions and records the acceptance only once', async () => {
    const a = await ready();
    const [first, second] = await Promise.all([
      service.sign(token, a.id, input(a), {}),
      service.sign(token, a.id, input(a), {}),
    ]);
    expect(first.current!.signedAt).toEqual(second.current!.signedAt);
    expect(pdf.receipt).toHaveBeenCalledTimes(1);
    expect(f.state().eventLog).toHaveLength(1);
    await service.sign(
      token,
      a.id,
      { ...input(a), signerName: 'Someone else' },
      {},
    );
    expect(f.state().estimateAgreement[0].signerName).toBe('Jane Rivera');
  });
  it('denies other estimates, other dealers, disabled links and cross-report downloads', async () => {
    const a = await ready();
    await expect(
      service.publicDocument('wrong-token', a.id, 'quote'),
    ).rejects.toThrow('not found');
    await expect(
      service.ownerDocument(1, a.id, 'quote', {
        id: 8,
        role: { name: 'dealer' },
      }),
    ).rejects.toThrow('not found');
    await expect(
      service.publicDocument(`total_${token}`, a.id, 'quote'),
    ).rejects.toThrow('not found');
    f.state().estimate[0].publicTokenEnabled = false;
    await expect(service.publicSnapshot(token, a.id)).rejects.toThrow(
      'not found',
    );
  });
  it('keeps the assigned contract after a branding replacement until the dealer explicitly applies it', async () => {
    const a = await ready();
    await service.sign(token, a.id, input(a), {});
    const newer = await PDFDocument.create();
    newer.addPage();
    newer.addPage();
    await service.upload(dealer, {
      buffer: Buffer.from(await newer.save()),
      originalname: 'New contract.pdf',
    } as any);
    expect((await ready()).contract!.version).toBe(1);
    const changed = await service.prepare(1, 'detailed', true, dealer);
    expect(changed.current!.contract!.version).toBe(2);
    expect(changed.current!.signedAt).toBeNull();
    expect(f.state().estimateAgreement[0].invalidatedAt).not.toBeNull();
    expect(
      (await service.estimateInfo(1, 'detailed', dealer)).history,
    ).toHaveLength(1);
  });
  it('never stores hidden dealer prices in a project-total snapshot', async () => {
    await ready('total');
    const snapshot = f.state().estimateAgreement[0].snapshot;
    expect(snapshot.customerPriceT).toBe(0);
    expect(snapshot.pieces[0].customerPrice).toBe(0);
    expect(snapshot.publicProjectTotal).toBe(1070);
    expect(snapshot).not.toHaveProperty('rateT');
  });
  it('rejects blank signatures and detects a corrupted saved document', async () => {
    const a = await ready();
    await expect(
      service.sign(
        token,
        a.id,
        { ...input(a), signature: [[{ x: 0, y: 0 }]] },
        {},
      ),
    ).rejects.toThrow('Draw your signature');
    f.state().estimateAgreement[0].quoteHash = '0'.repeat(64);
    await expect(service.sign(token, a.id, input(a), {})).rejects.toThrow(
      'verified',
    );
    expect(f.state().estimateAgreement[0].signedAt).toBeNull();
  });

  function installation(internal = true) {
    const e = f.state().estimate[0];
    if (internal) {
      e.dealerModeSnapshot = 'INTERNAL';
      e.user.dealerMode = 'INTERNAL';
    }
    e.installationJob = {
      id: 5,
      status: 'PERMIT_PROCESSING',
      quotes: [
        {
          status: 'APPROVED',
          total: '1000.00',
          lines: [],
          serviceMinimumsSnapshot: [],
        },
      ],
      permit: { permitFeeSnapshot: '1500.00', cityFee: null },
    };
    return e;
  }

  it.each(['detailed', 'total'] as const)(
    'creates a %s City Fee change order against the last signed charges',
    async (mode) => {
      const e = installation();
      const publicToken = mode === 'total' ? `total_${token}` : token;
      const first = await ready(mode);
      await service.sign(publicToken, first.id, input(first), {});
      const originalPdf = await service.publicDocument(
        publicToken,
        first.id,
        'signed',
      );
      e.installationJob.permit.cityFee = '300.00';
      expect(
        (await service.estimateInfo(1, mode, dealer)).nextSignatureKind,
      ).toBe('CHANGE_ORDER');
      const next = await ready(mode);
      expect(next.kind).toBe('CHANGE_ORDER');
      expect(next.baseAgreementId).toBe(first.id);
      const info = await service.publicInfo(publicToken, next.id);
      expect(info.paymentsEnabled).toBe(true);
      expect(info.history.map((row) => row.id)).toEqual([first.id]);
      expect(info.changeOrder).toMatchObject({
        previousTotal: '3570.00',
        newTotal: '3870.00',
        difference: '300.00',
        previousIncomplete: true,
        newIncomplete: false,
      });
      if (mode === 'detailed')
        expect(info.changeOrder.items).toEqual([
          {
            description: 'City Fee',
            before: {
              key: 'City Fee:1',
              description: 'City Fee',
              amount: null,
            },
            after: {
              key: 'City Fee:1',
              description: 'City Fee',
              amount: '300.00',
            },
          },
        ]);
      else expect(info.changeOrder.items).toEqual([]);
      const nextSnapshot: any = await service.publicSnapshot(
        publicToken,
        next.id,
      );
      const html = changeOrderHtml(nextSnapshot);
      expect(html).toContain('Change Order #1');
      expect(html).toContain('$3,870.00');
      if (mode === 'detailed') expect(html).toContain('Pending');
      else expect(html).not.toContain('$1,000.00');
      await service.sign(publicToken, next.id, input(next), {});
      expect(
        (
          await PDFDocument.load(
            await service.publicDocument(publicToken, next.id, 'signed'),
          )
        ).getPageCount(),
      ).toBe(2);
      expect(
        await service.publicDocument(publicToken, first.id, 'signed'),
      ).toEqual(originalPdf);
      e.installationJob.quotes[0].total = '1200.00';
      const third = await ready(mode);
      const thirdInfo = await service.publicInfo(publicToken, third.id);
      expect(third.changeOrderNumber).toBe(2);
      expect(third.baseAgreementId).toBe(next.id);
      expect(thirdInfo.changeOrder.difference).toBe('200.00');
      expect(thirdInfo.history.map((row) => row.id)).toEqual([
        next.id,
        first.id,
      ]);
    },
  );

  it.each(['ignored', 'fixed'] as const)(
    'ignores %s external-dealer City Fee cost changes and keeps payments private',
    async (kind) => {
      const e = installation(false);
      e.customerCharges = [
        {
          id: 9,
          origin: 'SYSTEM',
          source: 'CITY_FEE',
          sourceKey: 'CITY_FEE',
          description: 'City Fee',
          pricingMode: 'FINAL',
          pricingValue: '500.00',
          usedInCustomerQuote: kind === 'fixed',
          sortOrder: 910,
        },
      ];
      const first = await ready();
      await service.sign(token, first.id, input(first), {});
      e.installationJob.permit.cityFee = '300.00';
      expect((await service.publicInfo(token, first.id)).current.state).toBe(
        'SIGNED',
      );
      expect((await service.publicInfo(token, first.id)).paymentsEnabled).toBe(
        false,
      );
      expect((await ready()).id).toBe(first.id);
      e.customerCharges[0].usedInCustomerQuote = true;
      e.customerCharges[0].pricingValue = '550.00';
      expect((await ready()).kind).toBe('CHANGE_ORDER');
    },
  );

  it('supports dealer-created charges without a company permit or installation job', async () => {
    const first = await ready();
    await service.sign(token, first.id, input(first), {});
    f.state().estimate[0].customerCharges = [
      {
        id: 5,
        origin: 'DEALER',
        source: 'CUSTOM',
        description: 'Dealer permit processing',
        pricingMode: 'FINAL',
        pricingValue: '250.00',
        sortOrder: 1,
      },
    ];
    const next = await ready();
    const info = await service.publicInfo(token, next.id);
    expect(info.changeOrder.items[0]).toMatchObject({
      before: null,
      after: { amount: '250.00' },
    });
    expect(info.paymentsEnabled).toBe(false);
  });

  it.each(['width', 'qty', 'idConf', 'customerPrice'] as const)(
    'requires the complete agreement when material %s changes, including after a signed change order',
    async (field) => {
      const e = installation();
      const first = await ready();
      await service.sign(token, first.id, input(first), {});
      e.installationJob.permit.cityFee = '300.00';
      const change = await ready();
      await service.sign(token, change.id, input(change), {});
      e.pieces[0][field] = Number(e.pieces[0][field]) + 1;
      e.installationJob.quotes[0].total = '1400.00';
      expect(
        (await service.estimateInfo(1, 'detailed', dealer)).nextSignatureKind,
      ).toBe('AGREEMENT');
      const full = await ready();
      expect(full.kind).toBe('AGREEMENT');
      expect(full.baseAgreementId).toBeNull();
      expect(pdf.quote).toHaveBeenCalledTimes(2);
      expect(await service.publicSnapshot(token, full.id)).toHaveProperty(
        'installationSummary.installationTotal',
        '1400.00',
      );
    },
  );

  it('requires a complete agreement for a replacement dealer contract even if only fees changed', async () => {
    const e = installation();
    const first = await ready();
    await service.sign(token, first.id, input(first), {});
    e.installationJob.permit.cityFee = '300.00';
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    await service.upload(dealer, {
      buffer: Buffer.from(await doc.save()),
      originalname: 'Updated.pdf',
    } as any);
    expect(
      (await service.prepare(1, 'detailed', true, dealer)).current.kind,
    ).toBe('AGREEMENT');
  });

  it('rejects a stale change order and groups further edits against the last acceptance', async () => {
    const e = installation();
    const first = await ready();
    await service.sign(token, first.id, input(first), {});
    e.installationJob.permit.cityFee = '300.00';
    const stale = await ready();
    e.installationJob.quotes[0].total = '1100.00';
    await expect(
      service.sign(token, stale.id, input(stale), {}),
    ).rejects.toThrow('changed');
    const next = await ready();
    const info = await service.publicInfo(token, next.id);
    expect(info.changeOrder.difference).toBe('400.00');
    expect(info.changeOrder.items).toHaveLength(2);
    expect(next.baseAgreementId).toBe(first.id);
    expect(
      f.state().estimateAgreement.find((row: any) => row.id === stale.id),
    ).toBeUndefined();
  });

  it('supports a prior detailed signed agreement without rewriting its original snapshot or hash', async () => {
    const e = installation();
    const first = await ready();
    const row = f.state().estimateAgreement[0];
    row.materialHash = null;
    row.chargesSnapshot = null;
    row.contentHash = contentHash(e);
    first.contentHash = row.contentHash;
    await service.sign(token, first.id, input(first), {});
    const original = structuredClone(row.snapshot);
    const digest = row.contentHash;
    e.installationJob.permit.cityFee = '300.00';
    const next = await ready();
    expect(next.kind).toBe('CHANGE_ORDER');
    expect(row.snapshot).toEqual(original);
    expect(row.contentHash).toBe(digest);
  });

  it('keeps a legacy total-only acceptance valid until it changes, then requests a complete signature', async () => {
    const e = installation();
    const first = await ready('total');
    const row = f.state().estimateAgreement[0];
    row.materialHash = null;
    row.chargesSnapshot = null;
    row.contentHash = contentHash(e);
    first.contentHash = row.contentHash;
    await service.sign(`total_${token}`, first.id, input(first), {});
    expect((await ready('total')).id).toBe(first.id);
    e.installationJob.permit.cityFee = '300.00';
    expect((await ready('total')).kind).toBe('AGREEMENT');
  });

  it('treats installation discounts as charges and material discounts as full-agreement changes', async () => {
    const e = installation();
    const first = await ready();
    await service.sign(token, first.id, input(first), {});
    e.manualDiscount = {
      scope: 'INSTALLATION',
      type: 'AMOUNT',
      value: '100',
      materialDiscountBasis: 'BEFORE_TAX',
    };
    const change = await ready();
    expect(change.kind).toBe('CHANGE_ORDER');
    expect(
      (await service.publicInfo(token, change.id)).changeOrder.difference,
    ).toBe('-100.00');
    await service.sign(token, change.id, input(change), {});
    e.manualDiscount = {
      scope: 'MATERIAL',
      type: 'AMOUNT',
      value: '100',
      materialDiscountBasis: 'BEFORE_TAX',
    };
    expect((await ready()).kind).toBe('AGREEMENT');
  });

  it('does not impose a signature just because the dealer uploaded a contract', async () => {
    installation();
    expect(f.state().dealerContract).toHaveLength(1);
    expect(await getAgreementPaymentRequirement(f.db, 1, token)).toEqual({
      required: false, satisfied: true, signingUrl: null,
    });
    const { payments, create } = paymentHarness();
    await payments.createCheckoutSessionForPublicToken({ token });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('requires the issued agreement when agreementId is omitted, and accepts the same request after signing', async () => {
    installation();
    const a = await ready();
    const { payments, create } = paymentHarness();
    await expect(payments.createCheckoutSessionForPublicToken({ token })).rejects.toThrow('Review and sign');
    expect(create).not.toHaveBeenCalled();
    await service.sign(token, a.id, input(a), {});
    await payments.createCheckoutSessionForPublicToken({ token });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(['detailed', 'total'] as const)(
    'accepts a current %s signature from both payment links without signing the other document', async (signedMode) => {
      installation();
      const detailed = await ready('detailed');
      const total = await ready('total');
      const signed = signedMode === 'detailed' ? detailed : total;
      const other = signedMode === 'detailed' ? total : detailed;
      const signedToken = signedMode === 'detailed' ? token : `total_${token}`;
      const otherSnapshot = structuredClone(f.state().estimateAgreement.find(a => a.id === other.id).snapshot);
      await service.sign(signedToken, signed.id, input(signed), {});
      const originalPdf = await service.publicDocument(signedToken, signed.id, 'signed');
      const { payments, create } = paymentHarness();
      for (const [link, document] of [[token, detailed], [`total_${token}`, total]] as const) {
        expect(await getAgreementPaymentRequirement(f.db, 1, link)).toEqual({
          required: true, satisfied: true, signingUrl: null,
        });
        await payments.createCheckoutSessionForPublicToken({ token: link, agreementId: document.id });
        await payments.createCheckoutSessionForPublicToken({ token: link });
      }
      expect(create).toHaveBeenCalledTimes(4);
      const unsigned = f.state().estimateAgreement.find(a => a.id === other.id);
      expect(unsigned.signedAt).toBeNull();
      expect(unsigned.signature).toBeUndefined();
      expect(unsigned.snapshot).toEqual(otherSnapshot);
      expect(await service.publicDocument(signedToken, signed.id, 'signed')).toEqual(originalPdf);
      // Reconocer la firma no amplía el acceso al PDF detallado.
      await expect(service.publicDocument(`total_${token}`, detailed.id, 'quote')).rejects.toThrow('not found');
    },
  );

  it('only returns a signing link for the current token presentation', async () => {
    installation();
    const detailed = await ready();
    expect(await getAgreementPaymentRequirement(f.db, 1, `total_${token}`)).toEqual({
      required: true, satisfied: false, signingUrl: null,
    });
    const total = await ready('total');
    expect(await getAgreementPaymentRequirement(f.db, 1, `total_${token}`)).toEqual({
      required: true, satisfied: false,
      signingUrl: `/public/estimates/total_${token}/agreements/${total.id}`,
    });
    expect((await getAgreementPaymentRequirement(f.db, 1, token)).signingUrl).toContain(detailed.id);
  });

  it('rejects a supplied foreign or wrong-presentation agreement even when a valid signature exists', async () => {
    installation();
    const detailed = await ready();
    await service.sign(token, detailed.id, input(detailed), {});
    const foreign = { ...f.state().estimateAgreement[0], id: randomUUID(), estimateId: 2 };
    f.state().estimateAgreement.push(foreign);
    for (const id of [foreign.id, randomUUID()])
      await expect(requireSignedAgreementForPayment(f.db, 1, token, id)).rejects.toThrow('Review and sign');
    await expect(requireSignedAgreementForPayment(f.db, 1, `total_${token}`, detailed.id)).rejects.toThrow('Review and sign');
  });

  it('keeps a changed agreement required, accepts its signed Change Order across views, and rejects the stale document', async () => {
    const e = installation();
    const first = await ready();
    await service.sign(token, first.id, input(first), {});
    e.installationJob.permit.cityFee = '350.00';
    await expect(requireSignedAgreementForPayment(f.db, 1, token)).rejects.toThrow('Review and sign');
    const change = await ready();
    expect(change.kind).toBe('CHANGE_ORDER');
    await expect(requireSignedAgreementForPayment(f.db, 1, token)).rejects.toThrow('Review and sign');
    await service.sign(token, change.id, input(change), {});
    await expect(requireSignedAgreementForPayment(f.db, 1, `total_${token}`)).resolves.toBeUndefined();
    await expect(requireSignedAgreementForPayment(f.db, 1, token, first.id)).rejects.toThrow('Review and sign');
  });

  it('does not revive an invalidated signature after restoring the original content', async () => {
    const e = installation();
    const first = await ready();
    await service.sign(token, first.id, input(first), {});
    e.pieces[0].width = 49;
    await invalidateChangedAgreements(f.db, 1);
    e.pieces[0].width = 48;
    expect(await getAgreementPaymentRequirement(f.db, 1, token)).toEqual({
      required: true, satisfied: false, signingUrl: null,
    });
    await expect(requireSignedAgreementForPayment(f.db, 1, token)).rejects.toThrow('Review and sign');
  });

  it('requires the replacement contract but does not change acceptance on an unrelated upload', async () => {
    installation();
    const first = await ready();
    await service.sign(token, first.id, input(first), {});
    const replacement = await PDFDocument.create();
    replacement.addPage([400, 500]);
    await service.upload(dealer, { buffer: Buffer.from(await replacement.save()), originalname: 'New.pdf' } as any);
    await expect(requireSignedAgreementForPayment(f.db, 1, token)).resolves.toBeUndefined();
    const newer = (await service.prepare(1, 'total', true, dealer)).current!;
    await expect(requireSignedAgreementForPayment(f.db, 1, token)).rejects.toThrow('Review and sign');
    await service.sign(`total_${token}`, newer.id, input(newer), {});
    await expect(requireSignedAgreementForPayment(f.db, 1, token)).resolves.toBeUndefined();
  });

  it.each([250, 300])('keeps the installation deposit of %s payable without a contract signature', async amount => {
    installation();
    const first = await ready();
    const { payments, create, workflow } = paymentHarness(PaymentType.INSTALLATION_DEPOSIT, amount);
    await payments.createCheckoutSessionForPublicToken({
      token, agreementId: first.id, installationDepositTermsAccepted: true,
    });
    expect(workflow.getPaymentContext.mock.calls[0][3]).toBe(true);
    expect(create.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(amount * 100);
    expect(f.state().estimateAgreement[0].signedAt).toBeNull();
  });

  it('does not exempt a non-deposit charge just because it is $250', async () => {
    installation();
    await ready();
    const { payments, create } = paymentHarness(PaymentType.MATERIAL, 250);
    await expect(payments.createCheckoutSessionForPublicToken({ token })).rejects.toThrow('Review and sign');
    expect(create).not.toHaveBeenCalled();
  });

  it('checks current acceptance before resuming an existing Stripe checkout', async () => {
    installation();
    await ready();
    const { payments, create, retrieve } = paymentHarness();
    f.db.payment.findUnique.mockResolvedValue({ id: 42, status: 'PENDING', stripeSessionId: 'cs_open' });
    await expect(payments.createCheckoutSessionForPublicToken({ token })).rejects.toThrow('Review and sign');
    expect(create).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it.each([
    { sequences: [1] }, { sequences: [1, 2, 3] }, { payFullBalance: true, expectedBalance: 1370 },
  ])('checks acceptance for an installment selection or advance balance: %j', async selection => {
    installation();
    const first = await ready();
    const { payments, context } = paymentHarness(PaymentType.INSTALLMENT);
    jest.spyOn(payments as any, 'selectedPaymentContexts').mockImplementation(async (_tx, params: any) =>
      (params.sequences ?? [1, 2, 3]).map((sequence: number) => ({ ...context(), paymentSequence: sequence })),
    );
    const resume = jest.spyOn(payments as any, 'resumeOrCloseInstallmentCheckouts').mockResolvedValue({ url: 'https://checkout.stripe.com/group' });
    await expect(payments.createCheckoutSessionForPublicToken({ token, ...selection })).rejects.toThrow('Review and sign');
    expect(resume).not.toHaveBeenCalled();
    await service.sign(token, first.id, input(first), {});
    await expect(payments.createCheckoutSessionForPublicToken({ token, ...selection })).resolves.toEqual({ url: 'https://checkout.stripe.com/group' });
  });

  it('lets an external dealer pay independently of the unsigned customer contract', async () => {
    installation(false);
    await ready();
    const { payments, create } = paymentHarness();
    await payments.createCheckoutSessionForEstimate({ estimateId: 1, type: PaymentType.MATERIAL, user: dealer });
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.state().estimateAgreement[0].signedAt).toBeNull();
  });

  it('only opens an internal customer checkout for the signed current document and preserves its return link', async () => {
    const e = installation();
    e.installationJob.permit.cityFee = '300.00';
    const first = await ready();
    f.db.payment = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 42 }),
      update: jest.fn().mockResolvedValue({}),
    };
    const workflow = {
      getPaymentContext: jest.fn(async () => ({
        estimate: f.state().estimate[0],
        job: f.state().estimate[0].installationJob,
        paymentSequence: 1,
        description: 'Material and City Fee',
        baseAmount: new Prisma.Decimal(1370),
        surchargePercent: new Prisma.Decimal(0),
        surchargeAmount: new Prisma.Decimal(0),
        totalAmount: new Prisma.Decimal(1370),
      })),
    };
    const payments = new PaymentsService(
      f.db,
      {
        get: (key: string) =>
          key === 'STRIPE_SECRET_KEY'
            ? 'sk_test_local'
            : 'http://localhost:3000',
      } as any,
      workflow as any,
      {} as any,
    );
    jest.spyOn(payments, 'getPublicPaymentContext').mockResolvedValue({
      enabled: true,
      payment: { type: 'MATERIAL', sequence: 1 },
    } as any);
    const create = jest.fn().mockResolvedValue({
      id: 'cs_test',
      url: 'https://checkout.stripe.com/test',
    });
    (payments as any).stripe = { checkout: { sessions: { create } } };
    await expect(
      payments.createCheckoutSessionForPublicToken({
        token,
        agreementId: first.id,
      }),
    ).rejects.toThrow('Review and sign');
    expect(create).not.toHaveBeenCalled();
    await service.sign(token, first.id, input(first), {});
    expect(
      await payments.createCheckoutSessionForPublicToken({
        token,
        agreementId: first.id,
      }),
    ).toEqual({ url: 'https://checkout.stripe.com/test' });
    expect(create.mock.calls[0][0].success_url).toContain(
      `agreementId=${first.id}`,
    );
    expect(create.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(
      137000,
    );
    f.state().estimate[0].installationJob.permit.cityFee = '350.00';
    await expect(
      payments.createCheckoutSessionForPublicToken({
        token,
        agreementId: first.id,
      }),
    ).rejects.toThrow('Review and sign');
    await expect(
      payments.createCheckoutSessionForPublicToken({
        token: `total_${token}`,
        agreementId: first.id,
      }),
    ).rejects.toThrow('Review and sign');
    f.state().estimate[0].dealerModeSnapshot = 'EXTERNAL';
    await expect(
      payments.createCheckoutSessionForPublicToken({
        token,
        agreementId: first.id,
      }),
    ).rejects.toThrow('not found');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
