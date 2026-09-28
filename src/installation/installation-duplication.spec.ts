import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { InstallationWorkflowService } from './installation-workflow.service';
import { InstallationPricingService } from './installation-pricing.service';

const address = { street: '123 Project St', city: 'Miami', state: 'FL', postalCode: '33101' };
const actor = { id: 7, role: { name: 'dealer' } };
const decimal = (value: number) => new Prisma.Decimal(value);

function fixture() {
  const estimate: any = {
    id: 100, idUser: 7, status: { name: 'Active' }, order: null, payments: [], installationJob: null,
    paymentPlanSnapshot: { version: 1 }, user: { role: { name: 'dealer' }, noInstallationDeposit: false },
    pieces: [{ id: 1000, qty: 2, mark: 'W1', width: decimal(48), height: decimal(60), prod: { kind: 'GLAZED_UNIT' } }],
  };
  const source: any = {
    id: 21, estimateId: 1, status: 'COMPLETED', installationAddress: address,
    depositAmountSnapshot: decimal(999), depositTermsAcceptedAt: new Date('2025-01-01'),
    dealerMeasurementsAcceptedAt: new Date('2025-01-01'),
    permit: { status: 'APPROVED', permitFeeSnapshot: decimal(1), cityFee: decimal(500), permitNumber: 'OLD' },
    quotes: [{ id: 31, version: 5, status: 'APPROVED', approvedAt: new Date('2025-01-01'),
      profileId: 999, total: decimal(20), notes: 'Customer requests removal', lines: [
        { id: 50, origin: 'AUTO', serviceId: 1, rate: decimal(1), measurementId: 70 },
        { id: 51, origin: 'USER_SELECTED', serviceId: 2, rate: decimal(2), measurementId: 71,
          widthIn: decimal(30), heightIn: decimal(40), areaSqFt: null, panelCount: null,
          lengthIn: null, occurrences: 2, description: 'Remove old frames' },
        { id: 52, origin: 'FIELD_ADDED', serviceId: 3, rate: decimal(3), measurementId: 72,
          widthIn: null, heightIn: null, areaSqFt: null, panelCount: 2,
          lengthIn: null, occurrences: 1, description: 'Extra panels' },
      ] }],
    measurements: [{ id: 70, pieceId: 2, status: 'COMPLETED', measuredAt: new Date() }],
    appointments: [{ id: 90 }], approvals: [{ id: 91 }],
  };
  const coverage = {
    address,
    snapshot: { schema: 1, revision: 8, origin: address, destination: { ...address, placeId: 'current' },
      distanceMeters: 1000, maximumMiles: '80', includedMiles: '25',
      range: { type: 'FIXED', value: '50', fromMiles: '0', upToMiles: '80' } },
  };
  const profile = { id: 8, name: 'Current profile', adjustmentPercent: new Decimal(10), minimumCharge: new Decimal(0) };
  const services: any[] = [1, 2, 3].map(id => ({
    id, name: `Current service ${id}`, billingUnit: id === 3 ? 'PANEL' : 'UNIT', ruleMetric: 'NONE',
    baseRate: decimal(100 * id), minimumCharge: decimal(0), estimatedMinutes: decimal(30),
    isActive: true, availableForRequest: true, availableForField: true, rules: [],
  }));
  let job: any, quote: any;
  const lines: any[] = [];
  const tx: any = {
    estimate: { findUnique: jest.fn(async () => estimate) },
    globalParameter: { findUnique: jest.fn(async ({ where }) => ({ value: decimal(where.key === 'INSTALLATION_DEPOSIT' ? 100 : 250) })) },
    installationJob: { create: jest.fn(async ({ data }) => {
      job = { ...data, id: 300, estimate, measurements: data.measurements.create };
      quote = { ...data.quotes.create, id: 400, jobId: 300, job, lines, coverageSnapshot: { data: data.quotes.create.coverageSnapshot.create.data } };
      job.quotes = [quote]; return job;
    }) },
    installationQuote: {
      findUnique: jest.fn(async () => quote), findFirst: jest.fn(async () => null),
      update: jest.fn(async ({ data }) => Object.assign(quote, data)),
    },
    installationService: { findUnique: jest.fn(async ({ where }) => services.find(s => s.id === where.id)) },
    installationQuoteLine: {
      count: jest.fn(async () => lines.length), aggregate: jest.fn(async () => ({ _max: { sortOrder: lines.length - 1 } })),
      create: jest.fn(async ({ data }) => {
        const line = { ...data, id: 500 + lines.length, service: services.find(s => s.id === data.serviceId) };
        lines.push(line); return line;
      }),
    },
  };
  const pricing = new InstallationPricingService({} as any);
  jest.spyOn(pricing, 'resolveProfileForUser').mockResolvedValue(profile);
  const notifications = { createAndSend: jest.fn() };
  const workflow = new InstallationWorkflowService({} as any, pricing, {} as any, {} as any, {} as any, notifications as any);
  const verify = { prepare: jest.fn(async () => coverage), assertCurrent: jest.fn() };
  Object.assign(workflow, { coverage: verify });
  // Solo se aísla la resolución de mappings automáticos; los adicionales y totales son reales.
  const rebuild = jest.spyOn(workflow as any, 'rebuildAutomaticLines').mockImplementation(async (_jobId, quoteId) => {
    await tx.installationQuoteLine.create({ data: {
      quoteId, ...pricing.calculateLine({ service: services[0], profile, origin: 'AUTO', dimensions: {}, occurrences: 2 }),
    } });
  });
  return { source, estimate, tx, workflow, services, pricing, verify, rebuild, notifications, lines,
    job: () => job, quote: () => quote,
    duplicate: (user = actor) => workflow.duplicateInstallationInTransaction(100, source, user as any, coverage as any, tx),
  };
}

describe('Duplicated installation starts a new quote', () => {
  it('rebuilds current prices, pending measurements and fresh permit terms without copying execution history', async () => {
    const f = fixture(), original = JSON.stringify(f.source);
    await f.duplicate();
    expect(f.verify.assertCurrent).toHaveBeenCalledWith(expect.objectContaining({ revision: 8 }), f.tx);
    expect(f.rebuild).toHaveBeenCalledWith(300, 400, f.tx);
    expect(f.pricing.resolveProfileForUser).toHaveBeenCalledWith(7, f.tx);
    expect(f.quote()).toMatchObject({ version: 1, status: 'DRAFT', profileId: 8, notes: 'Customer requests removal' });
    expect(f.quote().total.toString()).toBe('1370');
    expect(f.lines.map(line => line.rate.toString())).toEqual(['100', '200', '300']);
    expect(f.lines.map(line => line.origin)).toEqual(['AUTO', 'USER_SELECTED', 'FIELD_ADDED']);
    expect(f.lines[1].description).toBe('Remove old frames');
    expect(f.lines[1].widthIn.toString()).toBe('30');
    expect(f.lines[1].measurementId).toBeNull();
    expect(f.job()).toMatchObject({ estimateId: 100, status: 'DEPOSIT_PAYMENT_PENDING', requestedById: 7, installationAddress: address });
    expect(f.job().depositAmountSnapshot.toString()).toBe('100');
    expect(f.job().permit.create.status).toBe('PAYMENT_PENDING');
    expect(f.job().permit.create.permitFeeSnapshot.toString()).toBe('250');
    expect(f.job().permit.create).not.toHaveProperty('cityFee');
    expect(f.job().measurements).toHaveLength(2);
    expect(f.job().measurements.map(m => [m.pieceId, m.unitIndex, m.status])).toEqual([[1000, 1, 'PENDING'], [1000, 2, 'PENDING']]);
    for (const key of ['depositTermsAcceptedAt', 'dealerMeasurementsAcceptedAt', 'appointments', 'approvals']) expect(f.job()).not.toHaveProperty(key);
    expect(f.quote()).not.toHaveProperty('approvedAt');
    expect(f.notifications.createAndSend).not.toHaveBeenCalled();
    expect(JSON.stringify(f.source)).toBe(original);
  });

  it.each(['admin', 'operator'])('records the %s actor but prices for the owner', async role => {
    const f = fixture(); await f.duplicate({ id: 90, role: { name: role } });
    expect(f.job().requestedById).toBe(90);
    expect(f.pricing.resolveProfileForUser).toHaveBeenCalledWith(7, f.tx);
  });

  it('revalidates current coverage instead of trusting the old address confirmation', async () => {
    const f = fixture(); await f.workflow.prepareDuplicateInstallation(f.source);
    expect(f.verify.prepare).toHaveBeenCalledWith(address);
    f.verify.assertCurrent.mockRejectedValue(new ConflictException('Pricing changed'));
    await expect(f.duplicate()).rejects.toThrow('Pricing changed');
    expect(f.tx.installationJob.create).not.toHaveBeenCalled();
  });

  it('rejects unavailable selected services instead of silently omitting them', async () => {
    const f = fixture(); f.services[1].isActive = false;
    await expect(f.duplicate()).rejects.toThrow('service is unavailable');
  });

  it('does not inherit a manual deposit waiver from the original', async () => {
    const f = fixture(); await f.duplicate();
    expect(f.job().status).toBe('DEPOSIT_PAYMENT_PENDING');
    expect(f.job()).not.toHaveProperty('dealerMeasurementsAcceptedAt');
    expect(f.job().measurements.every(m => m.status === 'PENDING')).toBe(true);
  });

  it('rejects an incomplete address without sending an external request', async () => {
    const f = fixture(); f.source.installationAddress = null;
    await expect(f.workflow.prepareDuplicateInstallation(f.source)).rejects.toThrow('address is incomplete');
    expect(f.verify.prepare).not.toHaveBeenCalled();
  });
});
