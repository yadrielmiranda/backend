import { InstallationJobStatus, InstallationPermitStatus } from '@prisma/client';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { InstallationWorkflowService } from './installation-workflow.service';
import { operationalInstallationListWhere } from './installation-list-visibility';
import type { FindInstallationJobsQueryDto } from './dto/find-installation-jobs-query.dto';

const admin = { id: 1, role: { name: 'admin' } } as AuthUser;
const dealer = { id: 7, role: { name: 'dealer' } } as AuthUser;
const measuredAt = new Date('2026-10-07T12:00:00Z');
const approvedQuote = { id: 1, version: 1, status: 'APPROVED', total: '500.00' };

// Execute the query predicate against business fixtures. This interprets Prisma
// operators only; the production helper supplies every visibility decision.
function matches(value: any, condition: any): boolean {
  if (condition == null) return value == null;
  if (typeof condition !== 'object') return value === condition;
  const list = (input: any) => Array.isArray(input) ? input : [input];
  return Object.entries(condition).every(([key, expected]: [string, any]) => {
    switch (key) {
      case 'AND': return list(expected).every(item => matches(value, item));
      case 'OR': return list(expected).some(item => matches(value, item));
      case 'NOT': return list(expected).every(item => !matches(value, item));
      case 'equals': return matches(value, expected);
      case 'not': return !matches(value, expected);
      case 'in': return expected.includes(value);
      case 'notIn': return !expected.includes(value);
      case 'contains': return typeof value === 'string' && value.includes(expected);
      case 'is': return expected == null ? value == null : value != null && matches(value, expected);
      case 'isNot': return expected == null ? value != null : value == null || !matches(value, expected);
      case 'some': return Array.isArray(value) && value.some(item => matches(item, expected));
      case 'none': return Array.isArray(value) && value.every(item => !matches(item, expected));
      case 'every': return Array.isArray(value) && value.every(item => matches(item, expected));
      default: return matches(value?.[key], expected);
    }
  });
}

function job(id: number, status: InstallationJobStatus, overrides: any = {}) {
  return {
    id,
    estimateId: id + 1000,
    status,
    requestedAt: measuredAt,
    updatedAt: measuredAt,
    dealerMeasurementsAcceptedAt: null,
    estimate: {
      idUser: 7, number: String(id + 1000), name: `Project ${id}`,
      customerFirstName: 'Anna', customerLastName: 'Example', customerEmail: 'anna@example.test',
      status: { name: 'Active' }, order: null,
    },
    measurements: [],
    permit: null,
    payments: [],
    _count: { measurements: 0 },
    quotes: [],
    appointments: [],
    ...overrides,
  };
}

function serviceFixture(rows: ReturnType<typeof job>[]) {
  const accounts = [{ id: 10, parentDealerId: 7 }, { id: 11, parentDealerId: 10 }, { id: 99, parentDealerId: 98 }];
  const db = {
    user: { findMany: jest.fn(async ({ where }) => accounts.filter(account => matches(account, where))) },
    installationJob: {
      count: jest.fn(async ({ where }) => rows.filter(row => matches(row, where)).length),
      findMany: jest.fn(async ({ where, skip, take }) => rows
        .filter(row => matches(row, where))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id - a.id)
        .slice(skip, skip + take)),
    },
  };
  const service = new InstallationWorkflowService(db as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const list = (query: Partial<FindInstallationJobsQueryDto> = {}, user = admin) =>
    service.findJobs(query as FindInstallationJobsQueryDto, user);
  return { db, list };
}

describe('operational installation list visibility', () => {
  it.each([
    ['a calculated estimate', job(1, 'REQUESTED')],
    ['an unpaid deposit', job(2, 'DEPOSIT_PAYMENT_PENDING')],
    ['a checkout that was only opened', job(3, 'DEPOSIT_PAYMENT_PENDING', {
      payments: [{ type: 'INSTALLATION_DEPOSIT', status: 'PENDING', stripeSessionId: 'cs_open' }],
    })],
    ['a partial deposit that has not advanced the workflow', job(4, 'DEPOSIT_PAYMENT_PENDING', {
      payments: [{ type: 'INSTALLATION_DEPOSIT', status: 'PAID', baseAmount: '40', originalBaseAmount: '250', netPaidBaseAmount: '40' }],
    })],
    ['a waived installation awaiting material payment', job(5, 'MATERIAL_PAYMENT_PENDING', {
      dealerMeasurementsAcceptedAt: measuredAt, quotes: [approvedQuote],
    })],
    ['a waived installation awaiting permit payment', job(6, 'PERMIT_PAYMENT_PENDING', {
      dealerMeasurementsAcceptedAt: measuredAt, quotes: [approvedQuote], permit: { status: 'PAYMENT_PENDING', paidAt: null },
    })],
    ['editing the approved quote of a waived estimate', job(7, 'QUOTE_DRAFT', {
      dealerMeasurementsAcceptedAt: measuredAt, quotes: [{ ...approvedQuote, status: 'DRAFT' }],
    })],
    ['automatically copied measurements without a measurement visit', job(8, 'MATERIAL_PAYMENT_PENDING', {
      dealerMeasurementsAcceptedAt: measuredAt, quotes: [approvedQuote],
      measurements: [{ status: 'COMPLETED', measuredAt: null }],
    })],
    ['an initial quote approved without operational progress', job(9, 'REQUESTED', { quotes: [approvedQuote] })],
  ])('hides %s', (_name, fixture) => {
    expect(matches(fixture, operationalInstallationListWhere())).toBe(false);
  });

  it.each([
    'MEASUREMENT_SCHEDULING', 'MEASUREMENT_SCHEDULED', 'MEASUREMENT_PENDING',
    'QUOTE_DRAFT', 'ADMIN_APPROVAL_PENDING', 'CUSTOMER_APPROVAL_PENDING', 'APPROVED',
    'PERMIT_PAYMENT_PENDING', 'MATERIAL_PAYMENT_PENDING', 'PERMIT_PROCESSING',
    'MATERIAL_PAID', 'INSTALLATION_PAYMENT_PENDING', 'INSTALLATION_PAID',
    'SCHEDULING', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELED',
  ] as InstallationJobStatus[])('keeps the regular operational workflow at %s', status => {
    expect(matches(job(1, status), operationalInstallationListWhere())).toBe(true);
  });

  it('shows a waived installation once its order exists even if its status has not advanced', () => {
    const fixture = job(1, 'MATERIAL_PAYMENT_PENDING', { dealerMeasurementsAcceptedAt: measuredAt });
    fixture.estimate.order = { id: 3, number: '3003' };
    expect(matches(fixture, operationalInstallationListWhere())).toBe(true);
  });

  it('keeps a real measurement visible after the quote returns to a pre-order status', () => {
    const fixture = job(1, 'QUOTE_DRAFT', {
      dealerMeasurementsAcceptedAt: measuredAt,
      measurements: [{ status: 'COMPLETED', measuredAt }],
    });
    expect(matches(fixture, operationalInstallationListWhere())).toBe(true);
  });

  it.each(['PAID', 'SUBMITTED', 'CHANGES_REQUIRED', 'APPROVED', 'REJECTED'] as InstallationPermitStatus[])(
    'keeps actual permit activity at %s without requiring an order', status => {
      const fixture = job(1, 'MATERIAL_PAYMENT_PENDING', {
        dealerMeasurementsAcceptedAt: measuredAt, permit: { status, paidAt: null },
      });
      expect(matches(fixture, operationalInstallationListWhere())).toBe(true);
    },
  );

  it.each(['paidAt', 'submittedAt', 'approvedAt'])(
    'keeps a permit with %s visible while its current status is payment pending', timestamp => {
      const fixture = job(1, 'PERMIT_PAYMENT_PENDING', {
        dealerMeasurementsAcceptedAt: measuredAt, permit: { status: 'PAYMENT_PENDING', [timestamp]: measuredAt },
      });
      expect(matches(fixture, operationalInstallationListWhere())).toBe(true);
    },
  );

  it('retains canceled estimates in installation history', () => {
    const fixture = job(1, 'REQUESTED');
    fixture.estimate.status.name = 'Canceled';
    expect(matches(fixture, operationalInstallationListWhere())).toBe(true);
  });
});

describe('InstallationWorkflowService.findJobs operational filtering', () => {
  it('filters before counting and paginating and clamps a formerly valid page to the last page', async () => {
    const rows = [
      ...Array.from({ length: 31 }, (_, index) => job(index + 1, 'SCHEDULED')),
      ...Array.from({ length: 50 }, (_, index) => job(index + 100, 'REQUESTED')),
    ];
    const f = serviceFixture(rows);
    const result = await f.list({ page: 99, pageSize: 25 });
    expect(result).toMatchObject({ total: 31, page: 2, pageSize: 25, totalPages: 2 });
    expect(result.items.map(row => row.id)).toEqual([6, 5, 4, 3, 2, 1]);
    const countWhere = f.db.installationJob.count.mock.calls[0][0].where;
    const findArgs = f.db.installationJob.findMany.mock.calls[0][0];
    expect(findArgs.where).toBe(countWhere);
    expect(findArgs).toMatchObject({ skip: 25, take: 25, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] });
  });

  it('returns a stable empty first page when only unstarted estimates exist', async () => {
    const f = serviceFixture([job(1, 'REQUESTED'), job(2, 'DEPOSIT_PAYMENT_PENDING')]);
    expect(await f.list({ page: 5, scope: 'all' })).toMatchObject({ items: [], page: 1, total: 0, totalPages: 1 });
  });

  it.each([
    ['active', [2]], ['completed', [3]], ['canceled', [5, 4]], ['all', [5, 4, 3, 2]],
  ] as const)('preserves %s scope and its operational history', async (scope, expectedIds) => {
    const canceledEstimate = job(5, 'REQUESTED');
    canceledEstimate.estimate.status.name = 'Canceled';
    const f = serviceFixture([job(1, 'REQUESTED'), job(2, 'SCHEDULED'), job(3, 'COMPLETED'), job(4, 'CANCELED'), canceledEstimate]);
    const result = await f.list({ scope });
    expect(result.items.map(row => row.id)).toEqual(expectedIds);
    expect(result.total).toBe(expectedIds.length);
  });

  it('does not expose unstarted estimates through an explicit status filter', async () => {
    const withOrder = job(2, 'REQUESTED');
    withOrder.estimate.order = { id: 3, number: '3003' };
    const f = serviceFixture([job(1, 'REQUESTED'), withOrder, job(3, 'SCHEDULED')]);
    const result = await f.list({ scope: 'all', status: 'REQUESTED' });
    expect(result.items.map(row => row.id)).toEqual([2]);
  });

  it('keeps dealer access limited to their own jobs and descendant accounts', async () => {
    const rows = [7, 10, 11, 99].map((id, index) => {
      const row = job(index + 1, 'SCHEDULED');
      row.estimate.idUser = id;
      return row;
    });
    const f = serviceFixture(rows);
    const result = await f.list({}, dealer);
    expect(result.items.map(row => row.estimate.idUser)).toEqual([11, 10, 7]);
    expect(result.total).toBe(3);
    expect(f.db.user.findMany).toHaveBeenCalledTimes(2);
  });

  it('limits other account roles to their own installations', async () => {
    const other = job(2, 'SCHEDULED');
    other.estimate.idUser = 99;
    const f = serviceFixture([job(1, 'SCHEDULED'), other]);
    const result = await f.list({}, { id: 7, role: { name: 'client' } } as AuthUser);
    expect(result.items.map(row => row.id)).toEqual([1]);
    expect(f.db.user.findMany).not.toHaveBeenCalled();
  });

  it('lets administrators see operational jobs across account boundaries', async () => {
    const other = job(2, 'SCHEDULED');
    other.estimate.idUser = 99;
    const f = serviceFixture([job(1, 'SCHEDULED'), other, job(3, 'REQUESTED')]);
    expect((await f.list()).items.map(row => row.id)).toEqual([2, 1]);
    expect(f.db.user.findMany).not.toHaveBeenCalled();
  });

  it('combines multi-token order and customer search with operational visibility', async () => {
    const active = job(1, 'SCHEDULED');
    active.estimate.order = { id: 44, number: '4400' };
    const unstarted = job(2, 'REQUESTED');
    unstarted.estimate.number = '4400';
    const f = serviceFixture([active, unstarted, job(3, 'SCHEDULED')]);
    expect((await f.list({ search: 'Order #4400 Anna' })).items.map(row => row.id)).toEqual([1]);
  });
});
