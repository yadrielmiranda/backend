import { BadRequestException, ConflictException } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateTechnicianDto } from './dto/create-technician.dto';

jest.mock('bcrypt', () => ({ hash: jest.fn(async (value: string) => `test-only:${value}`) }));
const admin = { id: 1, role: { name: 'admin' as const } };
const dto = (): CreateTechnicianDto => ({ username: 'carlos.warehouse', firstName: 'Carlos', lastName: 'Test', password: 'password123' });
function fixture() {
  const records: any[] = [{ id: 2, username: 'carlos.sales', firstName: 'Carlos', lastName: 'Test', role: { name: 'dealer' }, idRole: 2,
    email: 'carlos@example.test', phone: '+13055550123', street: '1 Test St', city: 'Miami', state: 'FL', postalCode: '33101',
    dealerMode: 'EXTERNAL', deletedAt: null, isActive: true, passwordUpdatedAt: new Date() }];
  const logs = { log: jest.fn(async () => undefined) };
  const sessions = { findMany: jest.fn(async () => [{ id: 'session-tech' }]), updateMany: jest.fn(async () => ({ count: 1 })) };
  const db: any = {
    role: { findUnique: jest.fn(async ({ where }) => where.name === 'technician' || where.id === 5 ? { id: 5, name: 'technician' } : { id: 2, name: 'dealer' }) },
    user: {
      findFirst: jest.fn(async ({ where }) => structuredClone(records.find((u) => u.id === where.id) ?? null)),
      findUniqueOrThrow: jest.fn(async ({ where }) => structuredClone(records.find((u) => u.id === where.id))),
      create: jest.fn(async ({ data }) => {
        if (records.some((u) => u.username.toLowerCase() === data.username.toLowerCase())) throw { code: 'P2002' };
        const user = { ...data, id: Math.max(...records.map((u) => u.id)) + 1, idRole: 5, role: { name: 'technician' }, isActive: true, deletedAt: null,
          createdAt: new Date(), updatedAt: new Date(), passwordUpdatedAt: new Date() };
        records.push(user); return structuredClone(user);
      }),
      update: jest.fn(async ({ where, data }) => {
        const user = records.find((u) => u.id === where.id); Object.assign(user, data); return structuredClone(user);
      }),
    }, session: sessions, $queryRaw: jest.fn(async () => []),
  };
  db.$transaction = jest.fn(async (work) => work(db));
  return { records, logs, sessions, db, service: new UsersService(db, logs as any) };
}

describe('Separate administrator-created technician accounts', () => {
  it('creates without contact data and leaves the external dealer account unchanged', async () => {
    const f = fixture(), dealerBefore = structuredClone(f.records[0]);
    const saved = await f.service.createTechnicianAsAdmin(dto(), admin);
    expect(saved).toMatchObject({ username: 'carlos.warehouse', role: { name: 'technician' }, email: null, phone: null,
      street: null, city: null, state: null, postalCode: null, dealerMode: null, isTaxExempt: false, noInstallationDeposit: false });
    expect(f.records[0]).toEqual(dealerBefore);
    expect(f.logs.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE', userId: 1, entityType: 'User' }));
  });
  it('accepts multiple technicians with null email and phone but requires unique usernames', async () => {
    const f = fixture(); await f.service.createTechnicianAsAdmin(dto(), admin);
    await f.service.createTechnicianAsAdmin({ ...dto(), username: 'staff.second' }, admin);
    expect(f.records.filter((r) => r.email === null && r.phone === null)).toHaveLength(2);
    await expect(f.service.createTechnicianAsAdmin({ ...dto(), username: 'CARLOS.SALES' }, admin)).rejects.toThrow(ConflictException);
  });
  it('ignores injected commercial settings on the dedicated creation path', async () => {
    const f = fixture();
    const saved = await f.service.createTechnicianAsAdmin({ ...dto(), idRole: 1, email: 'fake@example.test', phone: '+13055550999',
      isTaxExempt: true, markupOverride: '99', paymentPlanId: 4, dealerMode: 'INTERNAL' } as any, admin);
    expect(saved.role.name).toBe('technician'); expect(saved.email).toBe(null); expect(saved.isTaxExempt).toBe(false);
    const data = f.db.user.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('markupOverride'); expect(data).not.toHaveProperty('paymentPlanId');
  });
  it('trims names and usernames without changing the password', async () => {
    const f = fixture();
    const saved = await f.service.createTechnicianAsAdmin({ ...dto(), username: ' carlos.warehouse ', firstName: ' Carlos ', lastName: ' Test ' }, admin);
    expect(saved).toMatchObject({ username: 'carlos.warehouse', firstName: 'Carlos', lastName: 'Test' });
    expect(f.db.user.create.mock.calls[0][0].data.password).not.toBe(dto().password);
  });
  it.each([
    { username: 'ab' }, { username: 'staff@example.test' }, { username: 'a b' }, { username: 'x'.repeat(51) },
    { firstName: null }, { firstName: '' }, { lastName: ' ' }, { password: 'short' }, { password: null },
    { password: 'a'.repeat(73) }, { password: '😀'.repeat(19) },
  ])('rejects invalid technician credentials %j', async (changes) => {
    const f = fixture(); await expect(f.service.createTechnicianAsAdmin({ ...dto(), ...changes } as any, admin)).rejects.toThrow(BadRequestException);
    expect(f.db.user.create).not.toHaveBeenCalled();
  });
  it('fails explicitly when the role migration has not been applied', async () => {
    const f = fixture(); f.db.role.findUnique.mockResolvedValue(null);
    await expect(f.service.createTechnicianAsAdmin(dto(), admin)).rejects.toThrow('migration');
    expect(f.db.user.create).not.toHaveBeenCalled();
  });
  it('never converts an existing external dealer account into a technician', async () => {
    const f = fixture(), before = structuredClone(f.records[0]);
    await expect(f.service.updateUser({ where: { id: 2 }, data: { idRole: 5 } })).rejects.toThrow('separate technician');
    await expect(f.service.updateTechnicianAsAdmin(2, { firstName: 'Changed' }, admin)).rejects.toThrow('not a technician');
    expect(f.records[0]).toEqual(before);
  });
  it.each(['idRole', 'email', 'phone', 'markupOverride', 'paymentPlanId', 'installationPriceProfileId', 'dealerMode', 'noInstallationDeposit'])('cannot attach %s to an internal account through the generic update route', async (field) => {
    const f = fixture(), saved = await f.service.createTechnicianAsAdmin(dto(), admin);
    await expect(f.service.updateUser({ where: { id: saved.id }, data: { [field]: null } as any })).rejects.toThrow('commercial');
    expect(f.db.user.update).not.toHaveBeenCalled();
  });
  it('resets passwords administratively, updates the password version and revokes sessions', async () => {
    const f = fixture(), saved = await f.service.createTechnicianAsAdmin(dto(), admin);
    await f.service.updateTechnicianAsAdmin(saved.id, { password: 'replacement123' }, admin);
    expect(f.db.user.update.mock.calls[0][0].data.passwordUpdatedAt).toBeInstanceOf(Date);
    expect(f.sessions.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: saved.id, revokedAt: null } }));
    expect(f.logs.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPDATE', meta: expect.objectContaining({ changedFields: ['password'] }) }));
  });
  it('keeps contact fields mandatory for commercial accounts even though the columns permit null', async () => {
    const f = fixture();
    await expect(f.service.createUser({ ...dto(), idRole: 2 } as any)).rejects.toThrow('required');
    await expect(f.service.createUser({ ...dto(), idRole: 5 } as any)).rejects.toThrow('separate technician');
    for (const field of ['email', 'phone', 'street', 'city', 'state', 'postalCode']) {
      await expect(f.service.updateUser({ where: { id: 2 }, data: { [field]: null } as any })).rejects.toThrow('required');
    }
  });
});
