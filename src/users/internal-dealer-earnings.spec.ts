import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UsersService } from './users.service';
import { buildDealerEarningsReport } from '@/common/dealer-earnings';
import { UsersController } from './users.controller';
import { ROLES_KEY } from '@/auth/roles.decorator';
import { EarningsPlansController, EarningsPlansService } from '@/earnings-plans/earnings-plans.module';
import { earningsPlanSnapshot, loadActiveEarningsPlan, validateEarningsRule } from '@/earnings-plans/earnings-plan';

jest.mock('bcrypt', () => ({ hash: jest.fn(async () => 'test-only-hash') }));

function fixture(mode: string | null = 'INTERNAL', roleName = 'dealer') {
  const account: any = { id: 7, idRole: 2, role: { name: roleName }, dealerMode: mode,
    dealerEarningsPlanId: mode === 'INTERNAL' ? 1 : null, phone: '+13055550111' };
  const records: any[] = [
    { id: 1, name: 'Markup team', basis: 'DEALER_MARKUP', percent: new Prisma.Decimal(100), isActive: true, revision: 1 },
    { id: 2, name: 'Sales A', basis: 'EXPECTED_PROFIT', percent: new Prisma.Decimal(20), isActive: true, revision: 1 },
    { id: 3, name: 'Sales B', basis: 'REAL_PROFIT', percent: new Prisma.Decimal(20), isActive: true, revision: 1 },
  ];
  const accounts = [account, { id: 8, dealerEarningsPlanId: 1 }];
  const sale = (changes = {}): any => ({ idUser: 7, dealerModeSnapshot: 'INTERNAL', status: { name: 'Active' },
    order: null, payments: [], dealerEarningsPlanSnapshot: earningsPlanSnapshot(records[0]),
    rateT: '1000', priceT: '1200', customerPriceT: '1500', netProfitD: '300', ...changes });
  const estimates = [sale(), sale({ status: { name: 'Expired' } }),
    sale({ status: { name: 'Ordered' }, order: { saleSubtotal: '1500', rate: '1000' } }),
    sale({ payments: [{ status: 'PAID', stripeSessionId: null }] }),
    sale({ payments: [{ status: 'REFUNDED', stripeSessionId: null }] }),
    sale({ payments: [{ status: 'PENDING', stripeSessionId: null }] }),
    sale({ payments: [{ status: 'FAILED', stripeSessionId: 'started-checkout' }] }),
    sale({ idUser: 8 }), sale({ status: { name: 'Canceled' } })];
  const withCount = (plan: any) => ({ ...plan, _count: { users: accounts.filter(u => u.dealerEarningsPlanId === plan.id).length } });
  const checkName = (data: any, id?: number) => {
    if (records.some(p => p.id !== id && p.name.toLowerCase() === data.name.toLowerCase()))
      throw new Prisma.PrismaClientKnownRequestError('Duplicate name', { code: 'P2002', clientVersion: 'test' });
  };
  const db: any = {
    $queryRaw: jest.fn(async (strings, id) => strings.join(' ').includes('FROM DealerEarningsPlan')
      ? records.filter(p => p.id === id).map(p => ({ ...p })) : []),
    user: {
      count: jest.fn(async ({ where }) => accounts.filter(u => u.dealerEarningsPlanId === where.dealerEarningsPlanId).length),
      findFirst: jest.fn(async () => ({ ...account })),
      findUniqueOrThrow: jest.fn(async () => ({ ...account })),
      findMany: jest.fn(async ({ where }) => accounts.filter(u => u.dealerEarningsPlanId === where.dealerEarningsPlanId).map(u => ({ id: u.id }))),
      create: jest.fn(async ({ data }) => ({ ...account, ...data, dealerEarningsPlanId: data.dealerEarningsPlan?.connect.id ?? null })),
      update: jest.fn(async ({ data }) => {
        if (data.dealerEarningsPlan) account.dealerEarningsPlanId = data.dealerEarningsPlan.connect?.id ?? null;
        return Object.assign(account, data);
      }),
    },
    role: { findUnique: jest.fn(async () => ({ id: 2, name: roleName })) },
    dealerEarningsPlan: {
      findUnique: jest.fn(async ({ where }) => records.find(p => p.id === where.id) ? { ...records.find(p => p.id === where.id) } : null),
      findMany: jest.fn(async () => records.map(withCount)),
      create: jest.fn(async ({ data }) => { checkName(data); const p = { ...data, id: records.length + 1 }; records.push(p); return withCount(p); }),
      update: jest.fn(async ({ where, data }) => { checkName(data, where.id); const p = records.find(p => p.id === where.id); Object.assign(p, data); return withCount(p); }),
      delete: jest.fn(async ({ where }) => {
        const index = records.findIndex(p => p.id === where.id);
        if (index < 0) throw new Error('Missing plan');
        return records.splice(index, 1)[0];
      }),
    },
    estimate: { updateMany: jest.fn() },
    eventLog: { create: jest.fn(async () => ({ id: 1 })) },
  };
  db.$transaction = jest.fn(async work => work(db));
  const logs = { log: jest.fn() };
  return { account, accounts, records, db, estimates, logs, service: new UsersService(db, logs as any), plans: new EarningsPlansService(db) };
}

describe('Admin-created earnings plan catalog and dealer assignments', () => {
  it('creates and lists 50 named plans with different percentages on the same base', async () => {
    const f = fixture();
    for (let n = 1; n <= 50; n++) await f.plans.save({ name: `Team ${n}`, basis: 'REAL_PROFIT', percent: String(n) }, 1);
    const saved = await f.plans.list();
    expect(saved).toHaveLength(53);
    expect(saved.slice(3).map(p => p.percent.toString())).toEqual(Array.from({ length: 50 }, (_, i) => String(i + 1)));
    expect(f.db.eventLog.create).toHaveBeenCalledTimes(50);
  });
  it('saves an assignment without bulk rewriting snapshots; eligible drafts synchronize when accessed', async () => {
    const f = fixture();
    const saved = JSON.stringify(f.estimates);
    await f.service.updateUserAsAdmin(7, { dealerEarningsPlanId: 2 }, { id: 1, role: { name: 'admin' } });
    expect(f.account.dealerEarningsPlanId).toBe(2);
    expect(JSON.stringify(f.estimates)).toBe(saved);
    expect(f.db.estimate.updateMany).not.toHaveBeenCalled();
    expect(f.estimates.map(e => buildDealerEarningsReport(e).dealerEarnings?.amount)).toEqual(Array(9).fill('300.00'));
    const newPlan = await loadActiveEarningsPlan(f.db, f.account.dealerEarningsPlanId);
    expect(newPlan).toMatchObject({ planId: 2, name: 'Sales A', basis: 'EXPECTED_PROFIT', percent: '20' });
    expect(f.logs.log).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ changedFields: ['dealerEarningsPlanId'] }) }));
  });
  it('edits the catalog without bulk rewriting snapshots; eligible drafts synchronize when accessed', async () => {
    const f = fixture();
    const saved = JSON.stringify(f.estimates);
    await f.plans.save({ name: 'Markup team revised', basis: 'DEALER_MARKUP', percent: '50' }, 1, 1);
    expect(f.records[0].revision).toBe(2);
    expect(JSON.stringify(f.estimates)).toBe(saved);
    expect(f.db.estimate.updateMany).not.toHaveBeenCalled();
    expect(f.estimates.map(e => buildDealerEarningsReport(e).dealerEarnings?.amount)).toEqual(Array(9).fill('300.00'));
    expect(buildDealerEarningsReport(f.estimates[0]).dealerEarnings?.planName).toBe('Markup team');
    expect(buildDealerEarningsReport(f.estimates[2]).dealerEarnings?.planName).toBe('Markup team');
    expect(await loadActiveEarningsPlan(f.db, 1)).toMatchObject({ percent: '50', name: 'Markup team revised' });
  });
  it('supports a percentage of dealer markup rather than requiring full markup', async () => {
    const f = fixture();
    const plan = await f.plans.save({ name: 'Partial markup', basis: 'DEALER_MARKUP', percent: '35' }, 1);
    await f.service.updateUser({ where: { id: 7 }, data: { dealerEarningsPlanId: plan.id } });
    const newEstimate = { ...f.estimates[0], dealerEarningsPlanSnapshot: await loadActiveEarningsPlan(f.db, f.account.dealerEarningsPlanId) };
    expect(buildDealerEarningsReport(newEstimate).dealerEarnings).toMatchObject({ planName: 'Partial markup', amount: '105.00', percent: '35' });
    expect(buildDealerEarningsReport(f.estimates[0]).dealerEarnings?.amount).toBe('300.00');
  });

  it('preserves zero historical earnings and the admin-created Markup total plan when assigning it', async () => {
    const f = fixture();
    f.records[0].name = 'Markup total';
    f.account.dealerEarningsPlanId = null;
    for (const e of f.estimates) e.dealerEarningsPlanSnapshot = {
      version: 2, planId: null, revision: null, name: 'No earnings plan assigned', basis: 'DEALER_MARKUP', percent: '0',
    };
    const saved = JSON.stringify(f.estimates);
    const plansBefore = JSON.stringify(f.records);
    await f.service.updateUserAsAdmin(7, { dealerEarningsPlanId: 1 }, { id: 1, role: { name: 'admin' } });
    expect(f.account.dealerEarningsPlanId).toBe(1);
    expect(JSON.stringify(f.records)).toBe(plansBefore);
    expect(JSON.stringify(f.estimates)).toBe(saved);
    expect(f.db.estimate.updateMany).not.toHaveBeenCalled();
    expect(f.estimates.map(e => buildDealerEarningsReport(e).dealerEarnings?.amount)).toEqual(Array(9).fill('0.00'));
    expect(await loadActiveEarningsPlan(f.db, 1)).toMatchObject({ name: 'Markup total', percent: '100' });
  });

  it('keeps the saved 25 percent after editing its catalog plan to 30 percent', async () => {
    const f = fixture();
    f.records[1].percent = new Prisma.Decimal(25);
    const e = f.estimates[2];
    e.dealerEarningsPlanSnapshot = earningsPlanSnapshot(f.records[1]);
    const before = JSON.stringify(e);
    await f.plans.save({ name: 'Sales A', basis: 'EXPECTED_PROFIT', percent: '30' }, 1, 2);
    expect(JSON.stringify(e)).toBe(before);
    expect(buildDealerEarningsReport(e).dealerEarnings).toMatchObject({ percent: '25', amount: '125.00' });
    expect(await loadActiveEarningsPlan(f.db, 2)).toMatchObject({ percent: '30' });
  });
  it('requires reassignment before deactivation and supports reactivation', async () => {
    const f = fixture();
    await expect(f.plans.save({ name: 'Markup team', basis: 'DEALER_MARKUP', percent: '100', isActive: false }, 1, 1)).rejects.toThrow('Assign another plan');
    await f.service.updateUser({ where: { id: 7 }, data: { dealerEarningsPlanId: 2 } });
    f.accounts[1].dealerEarningsPlanId = 2;
    expect((await f.plans.save({ name: 'Markup team', basis: 'DEALER_MARKUP', percent: '100', isActive: false }, 1, 1)).isActive).toBe(false);
    await expect(f.service.updateUser({ where: { id: 7 }, data: { dealerEarningsPlanId: 1 } })).rejects.toThrow('unavailable');
    expect((await f.plans.save({ name: 'Markup team', basis: 'DEALER_MARKUP', percent: '100', isActive: true }, 1, 1)).isActive).toBe(true);
  });
  it('rejects duplicate names while allowing plans to share a formula', async () => {
    const f = fixture();
    await expect(f.plans.save({ name: ' markup TEAM ', basis: 'REAL_PROFIT', percent: '30' }, 1)).rejects.toThrow('already exists');
    await expect(f.plans.save({ name: 'Another markup team', basis: 'DEALER_MARKUP', percent: '100' }, 1)).resolves.toMatchObject({ name: 'Another markup team' });
  });
  it.each([true, false])('deletes an unassigned plan with active=%s and preserves saved sales and their earnings', async isActive => {
    const f = fixture();
    const plan = f.records[1];
    plan.isActive = isActive;
    for (const e of f.estimates) e.dealerEarningsPlanSnapshot = earningsPlanSnapshot(plan);
    const savedEstimates = JSON.stringify(f.estimates);
    await expect(f.plans.remove(2, 99)).resolves.toEqual({ id: 2 });
    expect((await f.plans.list()).map(p => p.id)).not.toContain(2);
    expect(JSON.stringify(f.estimates)).toBe(savedEstimates);
    expect(buildDealerEarningsReport(f.estimates[2]).dealerEarnings).toMatchObject({ planId: 2, planName: 'Sales A', amount: '100.00' });
    expect(f.db.estimate.updateMany).not.toHaveBeenCalled();
    expect(f.db.user.update).not.toHaveBeenCalled();
    expect(f.db.eventLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: 'DELETE', entityType: 'DealerEarningsPlan', entityId: 2, userId: 99,
      tempLog: { create: { before: { ...earningsPlanSnapshot(plan), isActive }, after: Prisma.JsonNull } },
    }) });
    await expect(loadActiveEarningsPlan(f.db, 2)).rejects.toThrow('unavailable');
  });
  it('rejects deletion until every assigned dealer has another plan', async () => {
    const f = fixture();
    await expect(f.plans.remove(1, 1)).rejects.toThrow('Assign another plan');
    expect(f.db.dealerEarningsPlan.delete).not.toHaveBeenCalled();
    expect(f.db.eventLog.create).not.toHaveBeenCalled();
    await f.service.updateUser({ where: { id: 7 }, data: { dealerEarningsPlanId: 2 } });
    await expect(f.plans.remove(1, 1)).rejects.toThrow('Assign another plan');
    f.accounts[1].dealerEarningsPlanId = 2;
    await expect(f.plans.remove(1, 1)).resolves.toEqual({ id: 1 });
  });
  it('returns not found when deleting a nonexistent plan without writing an audit event', async () => {
    const f = fixture();
    await expect(f.plans.remove(999, 1)).rejects.toThrow('Earnings plan not found.');
    expect(f.db.dealerEarningsPlan.delete).not.toHaveBeenCalled();
    expect(f.db.eventLog.create).not.toHaveBeenCalled();
  });
  it('reports a protected assignment if the database rejects deletion through its foreign key', async () => {
    const f = fixture();
    f.db.dealerEarningsPlan.delete.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Foreign key constraint', { code: 'P2003', clientVersion: 'test' }));
    await expect(f.plans.remove(2, 1)).rejects.toThrow('Assign another plan');
    expect(f.records.map(p => p.id)).toContain(2);
    expect(f.db.eventLog.create).not.toHaveBeenCalled();
  });
  it('preserves the selected plan during unrelated profile updates', async () => {
    const f = fixture(); await f.service.updateUser({ where: { id: 7 }, data: { firstName: 'Updated' } });
    expect(f.account.dealerEarningsPlanId).toBe(1);
    expect(f.db.dealerEarningsPlan.findUnique).not.toHaveBeenCalled(); expect(f.db.estimate.updateMany).not.toHaveBeenCalled();
  });
  it('removes the assignment for external dealers without rewriting sale snapshots', async () => {
    const f = fixture(); await f.service.updateUser({ where: { id: 7 }, data: { dealerMode: 'EXTERNAL' } });
    expect(f.account.dealerEarningsPlanId).toBeNull(); expect(f.db.estimate.updateMany).not.toHaveBeenCalled();
  });
  it.each(['EXTERNAL', null])('does not assign a plan to a %s account', async mode => {
    const f = fixture(mode, mode ? 'dealer' : 'client');
    await expect(f.service.updateUser({ where: { id: 7 }, data: { dealerEarningsPlanId: 2 } })).rejects.toThrow(BadRequestException);
    expect(f.db.user.update).not.toHaveBeenCalled();
  });
  it.each([null, -1, 999])('rejects missing or unavailable plan id %s', async id => {
    const f = fixture();
    await expect(f.service.updateUser({ where: { id: 7 }, data: { dealerEarningsPlanId: id } })).rejects.toThrow(BadRequestException);
    expect(f.db.user.update).not.toHaveBeenCalled();
  });
  it('creates an internal dealer with an explicit catalog assignment', async () => {
    const f = fixture();
    const saved = await f.service.createUser({ idRole: 2, password: 'test', email: 'dealer@example.test', phone: '+13055550101',
      street: '1 Test St', city: 'Miami', state: 'FL', postalCode: '33101', dealerMode: 'INTERNAL', dealerEarningsPlanId: 3 } as any);
    expect(saved.dealerEarningsPlanId).toBe(3);
    expect(f.db.user.create.mock.calls[0][0].data.dealerEarningsPlan).toEqual({ connect: { id: 3 } });
  });
  it.each(['-1', '100.01', '', 'NaN', '20.12345'])('rejects invalid percentage %s', value => {
    expect(() => validateEarningsRule('DEALER_MARKUP', value)).toThrow(BadRequestException);
  });
  it.each(['0', '100', '20.1234'])('accepts percentage %s', value => {
    expect(validateEarningsRule('DEALER_MARKUP', value).percent).toBe(value);
  });
  it('restricts catalog management and assignment to administrators', () => {
    expect(Reflect.getMetadata(ROLES_KEY, EarningsPlansController)).toEqual(['admin']);
    expect(Reflect.getMetadata(ROLES_KEY, UsersController.prototype.updateUser)).toEqual(['admin']);
    expect(Reflect.getMetadata(ROLES_KEY, UsersController.prototype.createUser)).toEqual(['admin']);
  });
  it('uses the current locked plan instead of an earlier consistent-read version', async () => {
    const db: any = {
      $queryRaw: jest.fn(async () => [{ id: 8, name: 'Updated plan', revision: 2, basis: 'REAL_PROFIT', percent: '30', isActive: true }]),
      dealerEarningsPlan: { findUnique: jest.fn(async () => ({ id: 8, name: 'Earlier plan', revision: 1, basis: 'REAL_PROFIT', percent: '20', isActive: true })) },
    };
    expect(await loadActiveEarningsPlan(db, 8)).toMatchObject({ revision: 2, name: 'Updated plan', percent: '30' });
  });
});
