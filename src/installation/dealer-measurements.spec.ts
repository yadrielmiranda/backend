const confirmedAddress = { installationAddress: { street: '123 Example Street', city: 'Miami', state: 'FL', postalCode: '33101' }, installationAddressConfirmed: true };
import { ForbiddenException } from '@nestjs/common';
import {
  InstallationApprovalDecision,
  PaymentType,
  Prisma,
} from '@prisma/client';
import { InstallationWorkflowService } from './installation-workflow.service';
import { PaymentsService } from '@/payments/payments.service';

const admin = { id: 1, role: { name: 'admin' } } as const;
const dealer = { id: 7, role: { name: 'dealer' } } as const;
const customer = {
  customerFirstName: 'Jane',
  customerLastName: 'Rivera',
  customerEmail: 'jane@example.test',
  customerPhone: '+13055550111',
  customerStreet: '123 Example Street',
  customerCity: 'Miami',
  customerState: 'FL',
  customerPostalCode: '33101',
};

function fixture() {
  const estimate: any = {
    id: 2,
    idUser: dealer.id,
    number: '190001',
    status: { name: 'Active' },
    ...customer,
    user: { id: dealer.id, role: { name: 'dealer' }, dealerMode: 'INTERNAL' },
    priceT: new Prisma.Decimal(800),
    customerPriceT: new Prisma.Decimal(900),
    totalPayable: new Prisma.Decimal(800),
    customerTotalPayable: new Prisma.Decimal(900),
    dealerModeSnapshot: 'INTERNAL',
    publicTokenEnabled: true,
    publicToken: 'test-token',
    order: null,
    payments: [],
    manualDiscount: null,
    pieces: [
      {
        id: 8,
        mark: 'A',
        qty: 2,
        prod: { kind: 'GLAZED_UNIT' },
        width: new Prisma.Decimal('56.125'),
        height: new Prisma.Decimal('36.5'),
        sashHeight: new Prisma.Decimal('18.25'),
        windowHeight: new Prisma.Decimal('34.5'),
        horizontalHeights: [12.125, 24.375],
        panelCount: 2,
      },
      {
        id: 9,
        mark: 'B',
        qty: 1,
        prod: { kind: 'LINEAR_MATERIAL' },
        width: new Prisma.Decimal('96.75'),
      },
    ],
  };
  const quote: any = {
    id: 11,
    jobId: 3,
    status: 'DRAFT',
    version: 1,
    approvalReason: 'REMEASUREMENT',
    total: new Prisma.Decimal(1000),
    needsRecalculation: false,
    lines: [{ id: 13 }],
  };
  const measurements: any[] = [
    {
      id: 15,
      jobId: 3,
      pieceId: 8,
      unitIndex: 1,
      status: 'PENDING',
      isManual: false,
      widthIn: new Prisma.Decimal(50),
    },
  ];
  const job: any = {
    id: 3,
    estimateId: estimate.id,
    estimate,
    status: 'DEPOSIT_PAYMENT_PENDING',
    depositAmountSnapshot: new Prisma.Decimal(250),
    depositTermsAcceptedAt: null,
    dealerMeasurementsAcceptedAt: null,
    dealerMeasurementsAcceptedById: null,
    quotes: [quote],
    measurements,
    appointments: [],
    payments: estimate.payments,
    revisions: [],
    permit: null,
  };
  const revision: any = {
    id: 20,
    items: [],
    revisedTotals: { units: 3 },
    status: 'DRAFT',
  };
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: estimate.id }]),
    estimate: {
      findUnique: jest.fn(async () => ({ ...estimate, installationJob: job })),
      findFirst: jest.fn(async () => ({
        ...estimate,
        installationJob: job,
        extraCharges: [],
      })),
    },
    estimateAgreement: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    installationJob: {
      findUnique: jest.fn(async () => job),
      update: jest.fn(async ({ data }) => Object.assign(job, data)),
      delete: jest.fn(),
    },
    installationMeasurement: {
      updateMany: jest.fn(async ({ data }) => {
        measurements.forEach((m) => Object.assign(m, data));
        return { count: measurements.length };
      }),
      upsert: jest.fn(async ({ where, create, update }) => {
        const key = where.jobId_pieceId_unitIndex;
        const existing = measurements.find(
          (m) => m.pieceId === key.pieceId && m.unitIndex === key.unitIndex,
        );
        if (existing) return Object.assign(existing, update);
        const record = { id: 100 + measurements.length, ...create };
        measurements.push(record);
        return record;
      }),
      deleteMany: jest.fn(async ({ where }) => {
        const retained = measurements.filter((m) =>
          where.id.notIn.includes(m.id),
        );
        measurements.splice(0, measurements.length, ...retained);
      }),
      count: jest.fn(
        async () => measurements.filter((m) => m.status === 'PENDING').length,
      ),
      findMany: jest.fn(async () => measurements),
    },
    installationQuote: {
      findFirst: jest.fn(async () => quote),
      update: jest.fn(async ({ data }) => Object.assign(quote, data)),
      updateMany: jest.fn(async ({ where, data }) => {
        if (quote.status !== where.status) return { count: 0 };
        Object.assign(quote, data);
        return { count: 1 };
      }),
    },
    installationQuoteLine: {
      count: jest.fn().mockResolvedValue(1),
      deleteMany: jest.fn(),
    },
    installationPermit: {
      findUnique: jest.fn(async () => job.permit),
      create: jest.fn(async ({ data }) => (job.permit = { cityFee: null, ...data })),
      delete: jest.fn(async () => { job.permit = null; }),
    },
    installationQuoteApproval: { create: jest.fn() },
    installationAppointment: { create: jest.fn(), updateMany: jest.fn() },
    estimateRevision: {
      findUnique: jest.fn(async () => revision),
      update: jest.fn(async ({ data }) => Object.assign(revision, data)),
      updateMany: jest.fn(async ({ data }) => Object.assign(revision, data)),
    },
    estimateRevisionItem: { findMany: jest.fn(async () => revision.items) },
    eventLog: { create: jest.fn() },
    payment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn(
        async () =>
          estimate.payments.find(
            (p) => p.status === 'PENDING' && p.stripeSessionId,
          ) ?? null,
      ),
      aggregate: jest.fn(async () => ({ _sum: { baseAmount: null } })),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(async () => {
        for (const payment of estimate.payments) {
          if (
            payment.type === 'INSTALLATION_DEPOSIT' &&
            payment.status === 'PENDING' &&
            !payment.stripeSessionId
          )
            payment.status = 'CANCELED';
        }
      }),
    },
    globalParameter: {
      findUnique: jest.fn().mockResolvedValue({ value: new Prisma.Decimal(0) }),
    },
  };
  const prisma: any = {
    ...tx,
    $transaction: jest.fn(async (work) => {
      const beforeJob = { ...job };
      const beforeQuote = { ...quote };
      const beforeMeasurements = measurements.map((m) => ({ ...m }));
      try {
        return await work(tx);
      } catch (error) {
        Object.assign(job, beforeJob);
        Object.assign(quote, beforeQuote);
        measurements.splice(0, measurements.length, ...beforeMeasurements);
        throw error;
      }
    }),
  };
  const notifications = {
    createAndSend: jest.fn(),
    createAndSendToRoles: jest.fn(),
  };
  tx.installationQuoteCoverageSnapshot = { upsert: jest.fn(), findUnique: jest.fn().mockResolvedValue(null) };
  Object.assign(prisma, { installationQuoteCoverageSnapshot: tx.installationQuoteCoverageSnapshot });
  const workflow = new InstallationWorkflowService(
    prisma,
    {} as never,
    { log: jest.fn() } as never,
    {} as never,
    {} as never,
    notifications as never,
  );
  Object.assign(workflow, { coverage: { prepare: jest.fn().mockResolvedValue({ address: confirmedAddress.installationAddress, snapshot: { schema: 1, revision: 1 } }), assertCurrent: jest.fn() } });
  // Los cálculos se verifican en sus suites; aquí se prueban estados, medidas,
  // autorizaciones y pagos utilizando los métodos reales del flujo.
  jest.spyOn(workflow as any, 'rebuildAutomaticLines').mockResolvedValue(null);
  const recalculate = jest
    .spyOn(workflow as any, 'recalculateQuoteTotals')
    .mockResolvedValue(quote);
  jest
    .spyOn(workflow as any, 'ensureDraftRevision')
    .mockResolvedValue(revision);
  jest
    .spyOn(workflow as any, 'upsertMeasuredPieceRevision')
    .mockImplementation(async (...args: any[]) => {
      revision.items.push({ measurementId: args[1], action: 'UNCHANGED' });
    });
  measurements.splice(
    0,
    measurements.length,
    ...estimate.pieces.flatMap((piece) =>
      Array.from({ length: piece.qty }, (_, index) => ({
        id: 100 + piece.id * 10 + index,
        jobId: job.id,
        ...(workflow as any).measurementCreateFromPiece(piece, index + 1),
      })),
    ),
  );
  const payments = new PaymentsService(
    prisma,
    { get: () => 'sk_test_local_only' } as never,
    workflow,
    notifications as never,
  );
  return {
    workflow,
    payments,
    job,
    estimate,
    quote,
    measurements,
    tx,
    prisma,
    recalculate,
    revision,
  };
}

describe('Accepting dealer measurements without deposit or site visit', () => {
  it.each(['INTERNAL', 'EXTERNAL'])(
    'accepts an %s dealer and goes directly to material payment without approvals',
    async (mode) => {
      const f = fixture();
      f.estimate.dealerModeSnapshot = mode;
      await f.workflow.acceptDealerMeasurements(f.job.id, admin);
      expect(f.job.status).toBe('MATERIAL_PAYMENT_PENDING');
      expect(f.job.dealerMeasurementsAcceptedAt).toBeInstanceOf(Date);
      expect(f.job.dealerMeasurementsAcceptedById).toBe(admin.id);
      expect(f.job.depositAmountSnapshot.toFixed(2)).toBe('250.00');
      expect(f.job.depositTermsAcceptedAt).toBeNull();
      expect(f.job.payments).toEqual([]);
      expect(f.quote.status).toBe('APPROVED');
      expect(f.quote.approvalReason).toBe('DEALER_MEASUREMENTS');
      expect(f.measurements).toHaveLength(3);
      expect(
        f.measurements.slice(0, 2).map((m) => m.widthIn.toFixed(3)),
      ).toEqual(['56.125', '56.125']);
      expect(f.measurements[0].sashHeightIn.toString()).toBe('18.25');
      expect(f.measurements[0].horizontalHeights).toEqual([12.125, 24.375]);
      expect(f.measurements[2].lengthIn.toString()).toBe('96.75');
      expect(
        f.measurements.every(
          (m) =>
            m.status === 'COMPLETED' &&
            m.measuredAt === null &&
            m.measuredById === null,
        ),
      ).toBe(true);
      expect(f.tx.installationAppointment.create).not.toHaveBeenCalled();
      expect(f.tx.installationAppointment.updateMany).not.toHaveBeenCalled();
      expect(f.tx.payment.create).not.toHaveBeenCalled();
      expect(f.tx.payment.update).not.toHaveBeenCalled();
      expect(f.tx.installationQuoteApproval.create).not.toHaveBeenCalled();
      expect(f.tx.estimateRevision.update).not.toHaveBeenCalled();
      expect(f.recalculate).not.toHaveBeenCalled();
      expect(f.quote.total.toFixed(2)).toBe('1000.00');
      await expect(f.workflow.submitQuote(f.job.id, {}, admin)).rejects.toThrow(
        'already ready',
      );
      await expect(
        f.workflow.adminDecision(
          f.job.id,
          { decision: InstallationApprovalDecision.APPROVED },
          admin,
        ),
      ).rejects.toThrow('not pending admin');
    },
  );

  it.each(['client', 'operator'] as const)(
    'does not allow the %s role to grant the exception',
    async (role) => {
      const f = fixture();
      await expect(
        f.workflow.acceptDealerMeasurements(f.job.id, {
          id: 7,
          role: { name: role },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.tx.installationJob.update).not.toHaveBeenCalled();
    },
  );

  it('does not apply this exception to direct clients', async () => {
    const f = fixture();
    f.estimate.user.role.name = 'client';
    await expect(
      f.workflow.acceptDealerMeasurements(f.job.id, admin),
    ).rejects.toThrow('only available for dealer estimates');
  });

  it('lets the internal owner waive their own deposit', async () => {
    const f = fixture();
    await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
    expect(f.job.status).toBe('MATERIAL_PAYMENT_PENDING');
    expect(f.job.dealerMeasurementsAcceptedById).toBe(dealer.id);
  });

  it.each(['EXTERNAL', null])(
    'does not let a dealer with current mode %s self-authorize',
    async (mode) => {
      const f = fixture();
      f.estimate.user.dealerMode = mode;
      // El snapshot histórico INTERNAL no concede permisos actuales.
      await expect(
        f.workflow.acceptDealerMeasurements(f.job.id, dealer),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.tx.installationJob.update).not.toHaveBeenCalled();
    },
  );

  it("does not let an internal dealer waive someone else's deposit", async () => {
    const f = fixture();
    await expect(
      f.workflow.acceptDealerMeasurements(f.job.id, { ...dealer, id: 99 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.tx.installationJob.update).not.toHaveBeenCalled();
  });

  it.each(Object.keys(customer))(
    'can quote without %s but requires it before payment',
    async (field) => {
      const f = fixture();
      f.estimate[field] = '   ';
      await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
      expect(f.job.status).toBe('MATERIAL_PAYMENT_PENDING');
      await expect(
        f.workflow.getPaymentContext(
          f.estimate.id,
          PaymentType.MATERIAL,
          undefined,
          undefined,
          dealer,
          f.tx,
        ),
      ).rejects.toThrow(
        'before paying for this installation project. Missing:',
      );
      expect(f.tx.payment.create).not.toHaveBeenCalled();
      await expect(
        f.workflow.assertEstimateEditAllowed(f.estimate.id, dealer, true, f.tx),
      ).resolves.toBeUndefined();
    },
  );

  it('continues directly to permit payment when a permit is requested', async () => {
    const f = fixture();
    f.job.permit = {
      status: 'PAYMENT_PENDING',
      permitFeeSnapshot: new Prisma.Decimal(1500),
      cityFee: null,
    };
    await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
    expect(f.job.status).toBe('PERMIT_PAYMENT_PENDING');
    const context = await f.workflow.getPaymentContext(
      f.estimate.id,
      PaymentType.PERMIT,
      undefined,
      undefined,
      dealer,
      f.tx,
    );
    expect(context.baseAmount.toString()).toBe('1500');
  });

  it.each([
    { type: 'PERMIT', status: 'PENDING', stripeSessionId: 'cs_started' },
    { type: 'PERMIT', status: 'PAID', paidAt: new Date() },
    { type: 'MATERIAL', status: 'REFUNDED' },
  ])(
    'locks customer details after any checkout or payment: %j',
    async (payment) => {
      const f = fixture();
      await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
      f.estimate.payments.push(payment);
      await expect(
        f.workflow.assertEstimateEditAllowed(f.estimate.id, dealer, true, f.tx),
      ).rejects.toThrow('locked');
    },
  );

  it.each(['dimensions', 'quantity', 'configuration', 'dirty-price'])(
    'rejects an outdated calculation (%s)',
    async (change) => {
      const f = fixture();
      if (change === 'dimensions')
        f.estimate.pieces[0].width = new Prisma.Decimal(60);
      if (change === 'quantity') f.estimate.pieces[0].qty = 3;
      if (change === 'configuration') f.estimate.pieces[0].idConf = 42;
      if (change === 'dirty-price') f.quote.needsRecalculation = true;
      await expect(
        f.workflow.acceptDealerMeasurements(f.job.id, dealer),
      ).rejects.toThrow(/calculation/);
      expect(f.tx.installationJob.update).not.toHaveBeenCalled();
    },
  );

  it('uses the normal approval flow if services change after the exemption', async () => {
    const f = fixture();
    await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
    f.quote.status = 'DRAFT';
    f.quote.version = 2;
    f.quote.total = new Prisma.Decimal(1200);
    f.job.status = 'QUOTE_DRAFT';
    await f.workflow.submitQuote(f.job.id, {}, admin);
    expect(f.job.status).toBe('ADMIN_APPROVAL_PENDING');
    expect(f.quote.status).toBe('PENDING_ADMIN_APPROVAL');
  });

  it.each(['CARD', 'CASH'])('refuses a deposit paid by %s', async (method) => {
    const f = fixture();
    f.estimate.payments.push({
      type: 'INSTALLATION_DEPOSIT',
      status: 'PAID',
      paymentMethod: method,
    });
    await expect(
      f.workflow.acceptDealerMeasurements(f.job.id, admin),
    ).rejects.toThrow('before any project payment');
    expect(f.tx.installationJob.update).not.toHaveBeenCalled();
  });

  it('rechecks a checkout opened after the initial eligibility check', async () => {
    const f = fixture();
    f.workflow.assertDealerMeasurementsCanBeAccepted(f.job, admin);
    f.estimate.payments.push({
      type: 'INSTALLATION_DEPOSIT',
      status: 'PENDING',
      stripeSessionId: 'cs_new',
    });
    await expect(
      f.workflow.acceptDealerMeasurements(f.job.id, admin),
    ).rejects.toThrow('checkout was opened');
    expect(f.tx.installationMeasurement.upsert).not.toHaveBeenCalled();
  });

  it.each(['MEASUREMENT_SCHEDULING', 'CANCELED', 'COMPLETED'])(
    'rejects the ineligible stage %s',
    async (status) => {
      const f = fixture();
      f.job.status = status;
      await expect(
        f.workflow.acceptDealerMeasurements(f.job.id, admin),
      ).rejects.toThrow('while the installation deposit is pending');
    },
  );

  it('rolls back measurements if saving the final quote fails', async () => {
    const f = fixture();
    f.tx.installationQuote.update.mockRejectedValueOnce(
      new Error('Write failed'),
    );
    await expect(
      f.workflow.acceptDealerMeasurements(f.job.id, admin),
    ).rejects.toThrow('Write failed');
    expect(f.job.dealerMeasurementsAcceptedAt).toBeNull();
    expect(f.job.status).toBe('DEPOSIT_PAYMENT_PENDING');
    expect(f.measurements.every((m) => m.status === 'PENDING')).toBe(true);
  });

  it('does not repeat the authorization or replace its timestamp', async () => {
    const f = fixture();
    await f.workflow.acceptDealerMeasurements(f.job.id, admin);
    const acceptedAt = f.job.dealerMeasurementsAcceptedAt;
    await f.workflow.acceptDealerMeasurements(f.job.id, { ...admin, id: 12 });
    expect(f.job.dealerMeasurementsAcceptedAt).toBe(acceptedAt);
    expect(f.job.dealerMeasurementsAcceptedById).toBe(admin.id);
    expect(f.tx.eventLog.create).toHaveBeenCalledTimes(1);
  });

  it('cancels an unpaid deposit record without creating a payment credit', async () => {
    const f = fixture();
    f.estimate.payments.push({
      type: 'INSTALLATION_DEPOSIT',
      status: 'PENDING',
      stripeSessionId: null,
      baseAmount: new Prisma.Decimal(250),
    });
    await f.workflow.acceptDealerMeasurements(f.job.id, admin);
    expect(f.estimate.payments[0].status).toBe('CANCELED');
    expect(f.tx.payment.create).not.toHaveBeenCalled();
    expect(f.job.dealerMeasurementsAcceptedAt).toBeInstanceOf(Date);
  });

  it('blocks stale deposit checkout requests but keeps unpaid pieces editable', async () => {
    const f = fixture();
    await f.workflow.acceptDealerMeasurements(f.job.id, admin);
    await expect(
      f.workflow.getPaymentContext(
        f.estimate.id,
        PaymentType.INSTALLATION_DEPOSIT,
        undefined,
        true,
        dealer,
        f.tx,
      ),
    ).rejects.toThrow('not available for payment');
    await expect(
      f.workflow.assertEstimateEditAllowed(f.estimate.id, dealer),
    ).resolves.toBeUndefined();
    // También rechaza un estado incoherente: la autorización manda sobre la deuda.
    f.job.status = 'DEPOSIT_PAYMENT_PENDING';
    await expect(
      f.workflow.getPaymentContext(
        f.estimate.id,
        PaymentType.INSTALLATION_DEPOSIT,
        undefined,
        true,
        dealer,
        f.tx,
      ),
    ).rejects.toThrow('not available for payment');
  });

  it('charges the full installation balance when no deposit was paid', async () => {
    const f = fixture();
    await f.workflow.acceptDealerMeasurements(f.job.id, admin);
    f.quote.status = 'APPROVED';
    f.job.status = 'INSTALLATION_PAYMENT_PENDING';
    f.estimate.order = { id: 10, status: { name: 'Ready to pick up' } };
    const context = await f.workflow.getPaymentContext(
      f.estimate.id,
      PaymentType.INSTALLATION,
      undefined,
      undefined,
      dealer,
      f.tx,
    );
    expect(context.baseAmount.toFixed(2)).toBe('1000.00');
    expect(context.description).toBe('Installation balance — Estimate #190001');
  });

  it.each(['INTERNAL', 'EXTERNAL'])(
    'does not offer a waived deposit on an %s dealer public link',
    async (mode) => {
      const f = fixture();
      f.estimate.dealerModeSnapshot = mode;
      await f.workflow.acceptDealerMeasurements(f.job.id, admin);
      const context = await f.payments.getPublicPaymentContext('test-token');
      expect(context.payment?.type ?? null).toBe(
        mode === 'INTERNAL' ? 'MATERIAL' : null,
      );
      expect(context.enabled).toBe(mode === 'INTERNAL');
    },
  );

  it('keeps the normal deposit and remeasurement requirements without an exemption', async () => {
    const f = fixture();
    await expect(f.workflow.submitQuote(f.job.id, {}, admin)).rejects.toThrow(
      'Deposit payment and completed remeasurement',
    );
    const context = await f.workflow.getPaymentContext(
      f.estimate.id,
      PaymentType.INSTALLATION_DEPOSIT,
      undefined,
      true,
      dealer,
      f.tx,
    );
    expect(context.baseAmount.toFixed(2)).toBe('250.00');
    expect(f.job.dealerMeasurementsAcceptedAt).toBeNull();
  });
});


describe('Editing and removing an unpaid installation after waiving its deposit', () => {
  it.each(['INTERNAL', 'EXTERNAL'])(
    'keeps the %s request editable and can add/remove permit management without approvals',
    async (mode) => {
      const f = fixture();
      f.estimate.user.dealerMode = mode;
      await f.workflow.acceptDealerMeasurements(f.job.id, admin);
      const acceptedAt = f.job.dealerMeasurementsAcceptedAt;
      f.tx.globalParameter.findUnique.mockResolvedValue({ value: new Prisma.Decimal(1500) });
      await f.workflow.updateInstallationRequest(f.job.id, { ...confirmedAddress, permitRequested: true }, dealer);
      expect(f.job.status).toBe('PERMIT_PAYMENT_PENDING');
      expect(f.job.permit.permitFeeSnapshot.toString()).toBe('1500');
      expect(f.quote.status).toBe('APPROVED');
      await f.workflow.updateInstallationRequest(f.job.id, { ...confirmedAddress, permitRequested: false }, dealer);
      expect(f.job.status).toBe('MATERIAL_PAYMENT_PENDING');
      expect(f.job.permit).toBeNull();
      expect(f.job.dealerMeasurementsAcceptedAt).toBe(acceptedAt);
      expect(f.quote.version).toBe(1);
      expect(f.tx.installationQuoteApproval.create).not.toHaveBeenCalled();
      expect(f.tx.estimateRevision.update).not.toHaveBeenCalled();
    },
  );

  it('allows a waived installation price below the unused deposit amount', async () => {
    const f = fixture();
    await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
    f.quote.total = new Prisma.Decimal(100);
    await f.workflow.updateInstallationRequest(f.job.id, { ...confirmedAddress, permitRequested: false }, dealer);
    expect(f.quote.total.toString()).toBe('100');
    expect(f.quote.status).toBe('APPROVED');
  });

  it('opens the draft only inside the transaction when changing requested services', async () => {
    const f = fixture();
    await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
    const addLine = jest.spyOn(f.workflow as any, 'addLineInTransaction')
      .mockImplementation(async () => {
        expect(f.quote.status).toBe('DRAFT');
        f.quote.total = new Prisma.Decimal(1200);
      });
    await f.workflow.updateInstallationRequest(f.job.id, {
      ...confirmedAddress, permitRequested: false, selectedServices: [{ serviceId: 42, occurrences: 1 }],
    }, dealer);
    expect(addLine).toHaveBeenCalledTimes(1);
    expect(f.quote.status).toBe('APPROVED');
    expect(f.quote.total.toString()).toBe('1200');
    expect(f.job.status).toBe('MATERIAL_PAYMENT_PENDING');
  });

  it('updates accepted dimensions, units and removed pieces before material checkout', async () => {
    const f = fixture();
    await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
    const acceptedAt = f.job.dealerMeasurementsAcceptedAt;
    f.estimate.pieces[0].width = new Prisma.Decimal(60);
    f.estimate.pieces[0].qty = 3;
    f.estimate.pieces.pop();
    f.recalculate.mockImplementation(async () => {
      expect(f.quote.status).toBe('DRAFT');
      f.quote.total = new Prisma.Decimal(f.measurements.length * 400);
      return f.quote;
    });
    await f.prisma.$transaction((tx) => f.workflow.refreshUnpaidDealerMeasurements(f.estimate.id, tx));
    expect(f.measurements).toHaveLength(3);
    expect(f.measurements.every((m) => m.pieceId === 8 && m.widthIn.toString() === '60' &&
      m.status === 'COMPLETED' && !m.measuredAt && !m.measuredById)).toBe(true);
    expect(f.quote.total.toString()).toBe('1200');
    expect(f.quote.status).toBe('APPROVED');
    expect(f.job.status).toBe('MATERIAL_PAYMENT_PENDING');
    expect(f.job.dealerMeasurementsAcceptedAt).toBe(acceptedAt);
    expect(f.tx.installationQuoteApproval.create).not.toHaveBeenCalled();
    expect(f.tx.estimateRevision.update).not.toHaveBeenCalled();
    await expect(f.workflow.getPaymentContext(f.estimate.id, PaymentType.MATERIAL,
      undefined, undefined, dealer, f.tx)).resolves.toBeDefined();
    // El refresco del controlador no reabre ni vuelve a calcular una propuesta ya sincronizada.
    await f.workflow.refreshAfterEstimateChange(f.estimate.id, dealer);
    expect(f.recalculate).toHaveBeenCalledTimes(1);
    expect(f.quote.status).toBe('APPROVED');
  });

  it('removes surplus units when quantity is reduced', async () => {
    const f = fixture();
    await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
    f.estimate.pieces[0].qty = 1;
    await f.workflow.refreshUnpaidDealerMeasurements(f.estimate.id, f.tx);
    expect(f.measurements.filter((m) => m.pieceId === 8)).toHaveLength(1);
    expect(f.quote.status).toBe('APPROVED');
  });

  it('rolls back accepted measurements and quote state when recalculation fails', async () => {
    const f = fixture();
    await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
    f.estimate.pieces[0].width = new Prisma.Decimal(60);
    f.recalculate.mockRejectedValue(new Error('No matching installation price'));
    await expect(f.prisma.$transaction((tx) =>
      f.workflow.refreshUnpaidDealerMeasurements(f.estimate.id, tx))).rejects.toThrow('No matching');
    expect(f.measurements[0].widthIn.toString()).toBe('56.125');
    expect(f.quote.status).toBe('APPROVED');
  });

  it('removes the unpaid waived installation and can continue with material only', async () => {
    const f = fixture();
    await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
    await expect(f.workflow.cancelInstallation(f.job.id, {}, dealer)).resolves.toBeNull();
    expect(f.tx.installationJob.delete).toHaveBeenCalledWith({ where: { id: f.job.id } });
    expect(f.tx.payment.create).not.toHaveBeenCalled();
  });

  it.each(['PERMIT', 'MATERIAL', 'INSTALLATION_DEPOSIT', 'INSTALLATION'])(
    'blocks edits and removal once %s checkout has started', async (type) => {
      const f = fixture();
      await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
      // Incluye pagos del Estimate aunque no estén asociados al InstallationJob.
      f.job.payments = [];
      f.estimate.payments.push({ type, status: 'PENDING', stripeSessionId: 'cs_started' });
      await expect(f.workflow.updateInstallationRequest(f.job.id, { ...confirmedAddress, permitRequested: false }, dealer))
        .rejects.toThrow('before payment starts');
      await expect(f.workflow.cancelInstallation(f.job.id, {}, dealer)).rejects.toThrow('before payment starts');
      await expect(f.workflow.assertEstimateEditAllowed(f.estimate.id, dealer, false, f.tx)).rejects.toThrow('locked');
      expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
    },
  );

  it.each(['PAID', 'REFUNDED'])(
    'does not remove a waived installation with a %s project payment', async (status) => {
      const f = fixture();
      await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
      f.job.payments = [];
      f.estimate.payments.push({ type: 'PERMIT', status });
      await expect(f.workflow.cancelInstallation(f.job.id, {}, dealer)).rejects.toThrow('before payment starts');
      expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
    },
  );

  it('rechecks a payment that starts while the removal request is waiting', async () => {
    const f = fixture();
    await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
    f.job.payments = [];
    f.prisma.$transaction.mockImplementationOnce(async (work) => {
      f.estimate.payments.push({ type: 'MATERIAL', status: 'PAID' });
      return work(f.tx);
    });
    await expect(f.workflow.cancelInstallation(f.job.id, {}, dealer)).rejects.toThrow('before payment starts');
    expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
  });

  it('keeps later submitted quote revisions in the approval workflow', async () => {
    const f = fixture();
    await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
    f.quote.status = 'PENDING_ADMIN_APPROVAL';
    f.quote.submittedAt = new Date();
    f.job.status = 'ADMIN_APPROVAL_PENDING';
    await expect(f.workflow.updateInstallationRequest(f.job.id, { ...confirmedAddress, permitRequested: false }, dealer)).rejects.toThrow('before payment starts');
    await expect(f.workflow.refreshUnpaidDealerMeasurements(f.estimate.id, f.tx)).rejects.toThrow('locked');
    expect(f.quote.status).toBe('PENDING_ADMIN_APPROVAL');
  });

  it('denies installation edit/removal by another dealer', async () => {
    const f = fixture();
    await f.workflow.acceptDealerMeasurements(f.job.id, dealer);
    const other = { id: 99, role: { name: 'dealer' } } as const;
    await expect(f.workflow.updateInstallationRequest(f.job.id, { ...confirmedAddress, permitRequested: false }, other)).rejects.toThrow();
    await expect(f.workflow.cancelInstallation(f.job.id, {}, other)).rejects.toThrow();
    expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
  });
});


describe('Coverage policy preserved for an unchanged work address', () => {
  it('keeps the saved policy when services change at the same address', async () => {
    const f = fixture();
    f.job.installationAddress = confirmedAddress.installationAddress;
    const saved = { schema: 1, revision: 4, range: { type: 'FIXED', value: '150' } };
    f.tx.installationQuoteCoverageSnapshot.findUnique.mockResolvedValue({ data: saved });
    await f.workflow.updateInstallationRequest(f.job.id, { ...confirmedAddress, permitRequested: false }, dealer);
    expect((f.workflow as any).coverage.prepare).not.toHaveBeenCalled();
    expect((f.workflow as any).coverage.assertCurrent).not.toHaveBeenCalled();
    expect(f.tx.installationQuoteCoverageSnapshot.upsert.mock.calls[0][0].update.data).toEqual(saved);
  });
  it('rechecks coverage when the work address changes', async () => {
    const f = fixture();
    f.job.installationAddress = { ...confirmedAddress.installationAddress, street: '789 Previous Street' };
    await f.workflow.updateInstallationRequest(f.job.id, { ...confirmedAddress, permitRequested: false }, dealer);
    expect((f.workflow as any).coverage.prepare).toHaveBeenCalledWith(confirmedAddress.installationAddress);
    expect(f.job.installationAddress).toEqual(confirmedAddress.installationAddress);
  });
});


describe('Pre-existing installation deposit exemption', () => {
  it('does not bypass coverage when waiving a legacy preliminary deposit', async () => {
    const f = fixture();
    f.job.installationAddressConfirmedAt = null;
    await expect(f.workflow.acceptDealerMeasurements(f.job.id, admin)).rejects.toThrow('confirm its address');
    expect(f.job.dealerMeasurementsAcceptedAt).toBeNull();
  });
});
