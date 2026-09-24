import { NotFoundException } from '@nestjs/common';
import { EstimatesService } from '@/estimates/estimates.service';
import { OrdersService } from '@/orders/orders.service';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import type { AuthUser } from './types/auth-user.type';

jest.mock('@/payment-plans/payment-schedule', () => ({
  ...jest.requireActual('@/payment-plans/payment-schedule'),
  getPaymentSchedule: jest.fn().mockResolvedValue(null),
}));

function fixture() {
  const records = [11, 22].map(id => ({
    id, idUser: id, userId: id, status: { name: 'Active' },
    estimate: { idUser: id, payments: [], installationJob: null },
    installationJob: null, payments: [], deliveries: [], extraCharges: [],
    quotes: [], appointments: [], _count: { measurements: 0 },
  }));
  const select = (owner?: number) => records.filter(item => owner === undefined || item.idUser === owner);
  const db: any = {
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    estimate: { findMany: jest.fn(async ({ where }) => select(where?.idUser)) },
    order: {
      findMany: jest.fn(async ({ where }) => select(where?.userId)),
      findUnique: jest.fn().mockResolvedValue(records[1]),
    },
    installationJob: {
      count: jest.fn(async ({ where }) => select(where.AND?.find((f: any) => f.estimate?.idUser)?.estimate.idUser).length),
      findMany: jest.fn(async ({ where }) => select(where.AND?.find((f: any) => f.estimate?.idUser)?.estimate.idUser)),
      findUnique: jest.fn().mockResolvedValue(records[1]),
    },
  };
  const unused: any = {};
  const estimates = new EstimatesService(db, unused, unused, unused, unused, unused, unused, unused, unused);
  jest.spyOn(estimates, 'estimate').mockResolvedValue(records[1] as any);
  return {
    estimates,
    orders: new OrdersService(db, unused, unused, unused),
    installations: new InstallationWorkflowService(db, unused, unused, unused, unused, unused),
  };
}

describe('Account isolation after an administrator request', () => {
  const admin: AuthUser = { id: 1, role: { name: 'admin' } };
  const accounts: AuthUser[] = [
    { id: 11, role: { name: 'client' } },
    { id: 11, role: { name: 'dealer' } },
    { id: 22, role: { name: 'client' } },
  ];

  it.each(accounts)('only lists the current owner after admin for $id/$role.name', async account => {
    const f = fixture();
    expect(await f.estimates.findAllForUser(admin)).toHaveLength(2);
    expect(await f.orders.findAllForUser(admin)).toHaveLength(2);
    expect((await f.installations.findJobs({ scope: 'all' } as any, admin)).items).toHaveLength(2);

    expect((await f.estimates.findAllForUser(account)).map(item => item.idUser)).toEqual([account.id]);
    expect((await f.orders.findAllForUser(account)).map(item => item.userId)).toEqual([account.id]);
    const jobs = await f.installations.findJobs({ scope: 'all' } as any, account);
    expect(jobs.total).toBe(1);
    expect(jobs.items.map(item => item.estimate.idUser)).toEqual([account.id]);
  });

  it.each(['client', 'dealer'] as const)('blocks direct foreign record URLs for %s', async role => {
    const f = fixture();
    const account: AuthUser = { id: 11, role: { name: role } };
    await expect(f.estimates.findOneForUser(22, account)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.orders.findOneForUser(22, account)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.installations.findJob(22, account)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.installations.findJobByEstimate(22, account)).rejects.toBeInstanceOf(NotFoundException);
  });
});
