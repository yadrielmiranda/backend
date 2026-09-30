import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from '@/auth/auth.service';
import { validateAccessSession } from '@/auth/access-session';
import { presentApiResponse } from '@/common/response-privacy.interceptor';
import { DealerNetworkService } from './dealer-network.module';
import { SetNetworkSuspensionDto, ReviewNetworkSuspensionDto, UpdateNetworkMarkupDto } from './dealer-network.dto';
import { accountNetworkBlocked, networkAccessBlocked, networkSalesBlocked } from './network-access';
import { createNetworkSnapshot } from './dealer-network';

const actor = (id: number, role = 'dealer'): any => ({ id, role: { name: role } });
const secret = 'network-suspension-test-secret';

function fixture() {
  const users: any[] = [1, 2, 3, 4].map(id => ({
    id, username: `dealer${id}`, firstName: 'Test', lastName: 'Dealer', email: `dealer${id}@example.test`,
    phone: '+13055551234', street: '123 Example St', role: { name: 'dealer', markup: new Prisma.Decimal('.25') }, markupOverride: null, idRole: 2,
    passwordUpdatedAt: new Date(Date.now() - 60000),
    parentDealerId: id === 2 ? 1 : id === 3 ? 2 : null,
    dealerMode: 'EXTERNAL', isActive: true, deletedAt: null, networkSuspended: false, networkSuspendedByAdmin: false,
    networkMarkup: new Prisma.Decimal('.15'), subdealerEarningsMode: null, subdealerEarningsPercent: null,
  }));
  const actions: any[] = [];
  const withParent = (user: any): any => user && { ...user,
    networkBusinessActions: actions.filter(action => action.accountId === user.id).slice(-1),
    parentDealer: user.parentDealerId ? withParent(users.find(parent => parent.id === user.parentDealerId)) : null,
  };
  const sessions = new Map<string, any>();
  const matches = (session: any, where: any) => (!where.id || session.id === where.id) &&
    (where.userId === undefined || (typeof where.userId === 'number' ? session.userId === where.userId : where.userId.in.includes(session.userId))) &&
    (where.revokedAt !== null || session.revokedAt === null);
  const db: any = {
    $queryRaw: jest.fn(async () => []),
    globalParameter: { findUnique: jest.fn(async () => ({ value: new Prisma.Decimal('.07') })) },
    networkBusinessAction: {
      findUnique: jest.fn(async ({ where }) => actions.find(action => action.id === where.id) ?? null),
      findFirst: jest.fn(async ({ where }) => actions.find(action => action.accountId === where.accountId && action.activeSlot === where.activeSlot) ?? null),
      create: jest.fn(async ({ data }) => {
        const action = { id: actions.length + 1, createdAt: new Date(), activeSlot: null, reviewedAt: null, reviewNote: null, ...data };
        actions.push(action); return action;
      }),
      update: jest.fn(async ({ where, data }) => Object.assign(actions.find(action => action.id === where.id), data)),
      updateMany: jest.fn(async ({ where, data }) => {
        const found = actions.filter(action => action.accountId === where.accountId && action.activeSlot === where.activeSlot && action.id !== where.id?.not);
        found.forEach(action => Object.assign(action, data)); return { count: found.length };
      }),
    },
    user: {
      findUnique: jest.fn(async ({ where }) => withParent(users.find(user => user.id === where.id))),
      findMany: jest.fn(async ({ where }) => users.filter(user =>
        (!where.id?.in || where.id.in.includes(user.id)) &&
        (where.deletedAt !== null || !user.deletedAt) &&
        (where.parentDealerId === undefined || (typeof where.parentDealerId === 'number'
          ? user.parentDealerId === where.parentDealerId : where.parentDealerId.in.includes(user.parentDealerId)))
      ).map(withParent)),
      update: jest.fn(async ({ where, data }) => {
        const user = users.find(user => user.id === where.id);
        Object.assign(user, data);
        return { id: user.id, networkSuspended: user.networkSuspended };
      }),
    },
    session: {
      create: jest.fn(async ({ data }) => { const session = { revokedAt: null, ...data }; sessions.set(data.id, session); return session; }),
      findUnique: jest.fn(async ({ where }) => {
        const session = sessions.get(where.id);
        return session && { ...session, user: withParent(users.find(user => user.id === session.userId)) };
      }),
      findMany: jest.fn(async ({ where }) => [...sessions.values()].filter(session => matches(session, where))),
      update: jest.fn(async ({ where, data }) => Object.assign(sessions.get(where.id), data)),
      updateMany: jest.fn(async ({ where, data }) => {
        const found = [...sessions.values()].filter(session => matches(session, where));
        found.forEach(session => Object.assign(session, data));
        return { count: found.length };
      }),
    },
  };
  db.$transaction = jest.fn(async work => work(db));
  const logs = { log: jest.fn() };
  const jwt = new JwtService({ secret });
  const auth = new AuthService({ findOneByIdentifier: async (username: string) => users.find(user => user.username === username) } as any,
    db, jwt, logs as any, {} as any, {} as any, {} as any);
  (auth as any).bcryptRounds = 4;
  const notifications = { createAndSendToRoles: jest.fn(), createAndSend: jest.fn() };
  const service = new DealerNetworkService(db, logs as any, notifications as any);
  const sessionFor = async (id: number) => {
    const user = users.find(user => user.id === id), sid = auth.newSessionId();
    const refresh = await auth.signRefreshToken(id, sid, user.passwordUpdatedAt);
    await auth.createSession({ sessionId: sid, userId: id, refreshToken: refresh });
    const access = await auth.signAccessToken(user, sid);
    return { sid, refresh, payload: jwt.verify(access) };
  };
  return { users, actions, sessions, db, logs, notifications, service, auth, sessionFor };
}

describe('Suspending direct network accounts', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true } });

  it.each([true, false])('accepts the exact boolean %s without accepting profile or administrative fields', async suspended => {
    expect(await pipe.transform({ suspended, reason: '  Commercial review  ', firstName: 'Changed', isActive: true, parentDealerId: 99 },
      { type: 'body', metatype: SetNetworkSuspensionDto })).toEqual({ suspended, reason: 'Commercial review' });
  });

  it.each(['false', 'true', null, undefined, 0, 1])('rejects non-boolean suspension %s', async suspended => {
    await expect(pipe.transform({ suspended, reason: 'Commercial review' }, { type: 'body', metatype: SetNetworkSuspensionDto })).rejects.toThrow(BadRequestException);
  });

  it('keeps personal data and account access out of markup updates', async () => {
    const body: any = { markupPercent: 25, email: 'changed@example.test', username: 'changed', password: 'changed',
      isActive: true, networkSuspended: false, parentDealerId: 99 };
    expect(await pipe.transform(body, { type: 'body', metatype: UpdateNetworkMarkupDto })).toEqual({ markupPercent: 25 });
    const { service, db } = fixture();
    await service.updateMarkup(2, body, actor(1));
    const data = db.user.update.mock.calls[0][0].data;
    for (const field of ['email', 'username', 'password', 'isActive', 'networkSuspended', 'parentDealerId']) expect(data).not.toHaveProperty(field);
  });

  it('suspends new business without closing branch sessions or changing profile or administrative status', async () => {
    const f = fixture();
    const own = await f.sessionFor(1), sub = await f.sessionFor(2), distributor = await f.sessionFor(3), other = await f.sessionFor(4);
    const before = { ...f.users[1] };
    await expect(f.service.setSuspension(2, true, actor(1), 'Commercial review')).resolves.toEqual({ id: 2, networkSuspended: true });
    expect(f.users[1]).toEqual({ ...before, networkSuspended: true });
    expect(f.users[2].networkSuspended).toBe(false);
    expect(f.sessions.get(sub.sid).revokedAt).toBeNull();
    expect(f.sessions.get(distributor.sid).revokedAt).toBeNull();
    expect(f.db.session.updateMany).not.toHaveBeenCalled();
    expect(f.sessions.get(own.sid).revokedAt).toBeNull();
    expect(f.sessions.get(other.sid).revokedAt).toBeNull();
    expect(f.logs.log).toHaveBeenCalledWith(expect.objectContaining({ entityId: 2, userId: 1,
      before: { networkSuspended: false }, after: { networkSuspended: true },
    }), f.db);
  });

  it.each([[2, 3, 'dealer'], [99, 2, 'admin']] as const)('allows %s to suspend %s as %s', async (id, target, role) => {
    await expect(fixture().service.setSuspension(target, true, actor(id, role), 'Commercial review')).resolves.toMatchObject({ networkSuspended: true });
  });

  it.each([[1, 3], [2, 1], [2, 2], [4, 2], [3, 2], [99, 1]])('denies dealer %s access to account %s', async (id, target) => {
    const { service, db } = fixture();
    await expect(service.setSuspension(target, true, actor(id), 'Commercial review')).rejects.toThrow(NotFoundException);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it.each(['operator', 'client', 'technician'])('denies suspension by %s', async role => {
    await expect(fixture().service.setSuspension(2, true, actor(1, role), 'Commercial review')).rejects.toThrow(ForbiddenException);
  });

  it('does not let the dealer bypass an administrative block', async () => {
    const { users, service, db } = fixture();
    users[1].networkSuspended = true; users[1].isActive = false;
    await expect(service.setSuspension(2, false, actor(1), 'Commercial review')).rejects.toThrow('administrator');
    expect(db.user.update).not.toHaveBeenCalled();
    expect(users[1]).toMatchObject({ isActive: false, networkSuspended: true });
  });

  it('does not let an administratively inactive superior change a child account', async () => {
    const { users, service } = fixture();
    users[1].isActive = false;
    await expect(service.setSuspension(3, false, actor(2), 'Commercial review')).rejects.toThrow('parent network');
    await expect(service.updateMarkup(3, { markupPercent: 1 }, actor(2))).rejects.toThrow('parent network');
  });

  it('rejects an account deleted while waiting for its lock', async () => {
    const { users, service, db } = fixture();
    db.$queryRaw.mockImplementationOnce(async () => { users[1].deletedAt = new Date(); return []; });
    await expect(service.setSuspension(2, true, actor(1), 'Commercial review')).rejects.toThrow(NotFoundException);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('reactivates only its own suspension and preserves separately suspended children', async () => {
    const f = fixture(), session = await f.sessionFor(2);
    f.users[2].networkSuspended = true;
    await f.service.setSuspension(2, true, actor(1), 'Commercial review');
    await f.service.setSuspension(2, false, actor(1), 'Commercial review');
    expect(f.users[1].networkSuspended).toBe(false);
    expect(f.users[2].networkSuspended).toBe(true);
    expect(f.sessions.get(session.sid).revokedAt).toBeNull();
    await expect(validateAccessSession(f.db, session.payload)).resolves.toMatchObject({ id: 2 });
    await expect(accountNetworkBlocked(f.db, f.users[1])).resolves.toBe(false);
    await expect(accountNetworkBlocked(f.db, f.users[2])).resolves.toBe(false);
    await expect(accountNetworkBlocked(f.db, f.users[1], true)).resolves.toBe(false);
    await expect(accountNetworkBlocked(f.db, f.users[2], true)).resolves.toBe(true);
  });

  it('treats repeated suspension requests as idempotent', async () => {
    const f = fixture(); f.users[1].networkSuspended = true;
    await f.service.setSuspension(2, true, actor(1), 'Commercial review');
    expect(f.db.user.update).not.toHaveBeenCalled();
    expect(f.logs.log).not.toHaveBeenCalled();
  });

  it('shows inherited commercial suspension while keeping access available', async () => {
    const f = fixture(); f.users[1].networkSuspended = true;
    const response = presentApiResponse(await f.service.list(actor(99, 'admin')), actor(99, 'admin'));
    expect(response.members.find((member: any) => member.id === 2)).toMatchObject({ networkSuspended: true, networkAccessBlocked: false, networkSalesBlocked: true, canSuspend: true });
    expect(response.members.find((member: any) => member.id === 3)).toMatchObject({ networkSuspended: false, networkAccessBlocked: false, networkSalesBlocked: true, canSuspend: true });
    expect(response.members.find((member: any) => member.id === 2)).not.toHaveProperty('street');
  });

  it('cannot bypass inherited suspension by reactivating a distributor individually', async () => {
    const f = fixture();
    f.users[1].networkSuspended = true;
    f.users[2].networkSuspended = true;
    await f.service.setSuspension(3, false, actor(2), 'Commercial review');
    await expect(accountNetworkBlocked(f.db, f.users[2], true)).resolves.toBe(true);
    await f.service.setSuspension(2, false, actor(1), 'Commercial review');
    await expect(accountNetworkBlocked(f.db, f.users[2], true)).resolves.toBe(false);
  });

  it('disables new accounts and rejects creation through a direct API call, including an admin creating below a suspended parent', async () => {
    const f = fixture(); f.users[1].networkSuspended = true;
    expect((await f.service.list(actor(2))).canCreate).toBe(false);
    for (const creator of [actor(2), actor(99, 'admin')]) {
      await expect(f.service.create({ password: 'Example-password-123', parentDealerId: 2 } as any, creator))
        .rejects.toThrow('inactive or suspended');
    }
  });

  it.each([2, 3])('rejects new estimate pricing for suspended account %s, including inherited suspension', async id => {
    const f = fixture(); f.users[1].networkSuspended = true;
    await expect(createNetworkSnapshot(f.db, f.users[id - 1], '0.07')).rejects.toThrow(BadRequestException);
  });
});

describe('Dealer network markup visibility', () => {
  it.each([[null, '25'], ['.075', '7.5'], ['0', '0']])('shows the effective root markup with override %s to admin', async (override, expected) => {
    const f = fixture();
    f.users[0].markupOverride = override === null ? null : new Prisma.Decimal(override);
    f.users[2].networkMarkup = new Prisma.Decimal('.10');
    const viewer = actor(99, 'admin');
    const response = presentApiResponse(await f.service.list(viewer), viewer);
    expect(response.members.find((member: any) => member.id === 1)).toMatchObject({ markupPercent: expected, parentDealerId: null });
    expect(response.members.find((member: any) => member.id === 2)).toMatchObject({ markupPercent: '15', parentName: 'dealer1' });
    expect(response.members.find((member: any) => member.id === 3)).toMatchObject({ markupPercent: '10', parentName: 'dealer2' });
    expect(f.db.user.update).not.toHaveBeenCalled();
  });

  it('keeps a dealer within its own branch and exposes only its direct commercial terms', async () => {
    const f = fixture(), viewer = actor(1);
    const response = presentApiResponse(await f.service.list(viewer), viewer);
    expect(response.members.map((member: any) => member.id)).toEqual([1, 2, 3]);
    expect(response.members.find((member: any) => member.id === 2)).toMatchObject({ canManage: true, markupPercent: '15' });
    for (const id of [1, 3]) expect(response.members.find((member: any) => member.id === id)).not.toHaveProperty('markupPercent');
    expect(response.members.find((member: any) => member.id === 3)).toMatchObject({ parentDealerId: 2, canManage: false });
  });

  it('shows a subdealer only its own distributors and keeps markup private from operators', async () => {
    const f = fixture();
    const subdealer = await f.service.list(actor(2));
    expect(subdealer.members.map(member => member.id)).toEqual([2, 3]);
    expect(subdealer.members.find(member => member.id === 3)).toMatchObject({ canManage: true, markupPercent: '15' });
    const viewer = actor(99, 'operator');
    const response = presentApiResponse(await f.service.list(viewer), viewer);
    for (const member of response.members) {
      expect(member).not.toHaveProperty('markupPercent');
      expect(member).not.toHaveProperty('markupOverride');
      expect(member).not.toHaveProperty('role');
      expect(member.canManage).toBe(false);
    }
  });
});

describe('Network suspension across authentication flows', () => {
  it.each([2, 3])('permits login, existing HTTP/socket access and refresh for commercially suspended account %s', async id => {
    const f = fixture(), session = await f.sessionFor(id);
    f.users[id - 1].password = await bcrypt.hash('Example-password-123', 4);
    await expect(validateAccessSession(f.db, session.payload)).resolves.toMatchObject({ id });
    f.users[1].networkSuspended = true;
    await expect(f.auth.validateUser(`dealer${id}`, 'Example-password-123')).resolves.toMatchObject({ id });
    await expect(validateAccessSession(f.db, session.payload)).resolves.toMatchObject({ id });
    await expect(f.auth.refreshFromToken(session.refresh)).resolves.toBeDefined();
    expect(f.sessions.get(session.sid).revokedAt).toBeNull();
  });

  it('permits a new login after reactivation while an unrelated branch remains available', async () => {
    const f = fixture(); f.users[1].password = await bcrypt.hash('Example-password-123', 4);
    await f.service.setSuspension(2, true, actor(1), 'Commercial review');
    await expect(accountNetworkBlocked(f.db, f.users[3])).resolves.toBe(false);
    await f.service.setSuspension(2, false, actor(1), 'Commercial review');
    await expect(f.auth.validateUser('dealer2', 'Example-password-123')).resolves.toMatchObject({ id: 2 });
  });

  it('blocks descendants of an administratively disabled dealer without altering their individual status', async () => {
    const f = fixture(); f.users[0].isActive = false;
    await expect(accountNetworkBlocked(f.db, f.users[2])).resolves.toBe(true);
    expect(f.users[2]).toMatchObject({ isActive: true, networkSuspended: false });
    expect(networkAccessBlocked({ isActive: true, parentDealer: { isActive: false } })).toBe(true);
    expect(networkSalesBlocked({ isActive: true, parentDealer: { networkSuspended: true } })).toBe(true);
  });

  it.each([2, 3])('retains total login, HTTP/socket and refresh blocking for account %s when the ancestor is administratively disabled', async id => {
    const f = fixture(), session = await f.sessionFor(id);
    f.users[id - 1].password = await bcrypt.hash('Example-password-123', 4);
    f.users[0].isActive = false;
    await expect(f.auth.validateUser(`dealer${id}`, 'Example-password-123')).rejects.toThrow();
    await expect(validateAccessSession(f.db, session.payload)).rejects.toThrow(UnauthorizedException);
    await expect(f.auth.refreshFromToken(session.refresh)).rejects.toThrow(UnauthorizedException);
  });

  it('fails closed for a broken or cyclic hierarchy', async () => {
    const db: any = { user: { findUnique: jest.fn(async () => null) } };
    await expect(accountNetworkBlocked(db, { id: 3, parentDealerId: 2 })).resolves.toBe(true);
    db.user.findUnique.mockResolvedValue({ isActive: true, parentDealerId: 2 });
    await expect(accountNetworkBlocked(db, { id: 3, parentDealerId: 2 })).resolves.toBe(true);
  });
});

describe('New business authority and administrative requests', () => {
  const note = 'Commercial relationship under review';
  const pipe = new ValidationPipe({ transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true } });

  it.each([null, undefined, '', '  ', 'ab', 123, false, 'x'.repeat(501)])('rejects an invalid internal reason: %s', async reason => {
    await expect(pipe.transform({ suspended: true, reason }, { type: 'body', metatype: SetNetworkSuspensionDto }))
      .rejects.toThrow(BadRequestException);
  });

  it.each(['false', 'true', 1, undefined])('rejects an ambiguous administrative decision: %s', async approve => {
    await expect(pipe.transform({ approve, reason: note }, { type: 'body', metatype: ReviewNetworkSuspensionDto }))
      .rejects.toThrow(BadRequestException);
  });

  it.each([1, 2])('requires an internal superior at level %s to request approval without changing account status', async parentId => {
    const f = fixture(); f.users[0].dealerMode = 'INTERNAL'; f.users[parentId - 1].dealerMode = 'INTERNAL';
    const target = parentId + 1;
    await expect(f.service.setSuspension(target, true, actor(parentId), note)).rejects.toThrow(ForbiddenException);
    const request = await f.service.requestSuspension(target, true, actor(parentId), note);
    expect(f.users[target - 1].networkSuspended).toBe(false);
    expect(f.db.user.update).not.toHaveBeenCalled();
    expect(f.actions).toEqual([expect.objectContaining({ id: request.id, actorId: parentId, accountId: target,
      reason: note, status: 'PENDING', activeSlot: 1, createdAt: expect.any(Date) })]);
    const member = (await f.service.list(actor(parentId))).members.find(member => member.id === target)!;
    expect(member).toMatchObject({ canSuspend: false, canRequestSuspension: true, canReviewSuspension: false, canWithdrawRequest: true });
    expect(f.notifications.createAndSendToRoles).toHaveBeenCalledWith(['admin'], expect.objectContaining({ actionUrl: '/dealers' }), { db: f.db });
  });

  it('lets an external subdealer act directly even when its own parent is internal', async () => {
    const f = fixture(); f.users[0].dealerMode = 'INTERNAL';
    await f.service.setSuspension(3, true, actor(2), note);
    expect(f.users[2]).toMatchObject({ networkSuspended: true, networkSuspendedByAdmin: false });
    expect(f.actions[0]).toMatchObject({ actorId: 2, accountId: 3, reason: note, status: 'APPLIED' });
  });

  it('reads the current parent mode inside the transaction instead of trusting the browser or stale actor data', async () => {
    const f = fixture();
    f.db.$queryRaw.mockImplementationOnce(async () => { f.users[0].dealerMode = 'INTERNAL'; return []; });
    await expect(f.service.setSuspension(2, true, { ...actor(1), dealerMode: 'EXTERNAL' }, note))
      .rejects.toThrow(ForbiddenException);
    expect(f.db.user.update).not.toHaveBeenCalled();
  });

  it('approves once, preserves the requester reason and protects the administrative pause', async () => {
    const f = fixture(); f.users[0].dealerMode = 'INTERNAL';
    const request = await f.service.requestSuspension(2, true, actor(1), note);
    expect((await f.service.list(actor(99, 'admin'))).members.find(member => member.id === 2))
      .toMatchObject({ canReviewSuspension: true });
    await f.service.reviewSuspension(request.id, true, actor(99, 'admin'));
    expect(f.users[1]).toMatchObject({ networkSuspended: true, networkSuspendedByAdmin: true });
    expect(f.actions[0]).toMatchObject({ reason: note, status: 'APPLIED', activeSlot: null, reviewedById: 99, reviewedAt: expect.any(Date) });
    await expect(f.service.reviewSuspension(request.id, true, actor(99, 'admin'))).rejects.toThrow(ConflictException);
    expect(f.db.user.update).toHaveBeenCalledTimes(1);
    expect(f.notifications.createAndSend).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 1, actorId: 99 }), f.db);
    expect(f.db.session.updateMany).not.toHaveBeenCalled();
  });

  it.each(['dealer', 'operator', 'client', 'technician'])('prevents %s from deciding a request', async role => {
    const f = fixture(); f.users[0].dealerMode = 'INTERNAL';
    const request = await f.service.requestSuspension(2, true, actor(1), note);
    await expect(f.service.reviewSuspension(request.id, true, actor(1, role))).rejects.toThrow(ForbiddenException);
    expect(f.users[1].networkSuspended).toBe(false);
    expect(f.actions[0].status).toBe('PENDING');
  });

  it('declines with an internal explanation without pausing the account', async () => {
    const f = fixture(); f.users[0].dealerMode = 'INTERNAL';
    const request = await f.service.requestSuspension(2, true, actor(1), note);
    await expect(f.service.reviewSuspension(request.id, false, actor(99, 'admin'))).rejects.toThrow(BadRequestException);
    await f.service.reviewSuspension(request.id, false, actor(99, 'admin'), 'Commercial access remains approved');
    expect(f.users[1].networkSuspended).toBe(false);
    expect(f.actions[0]).toMatchObject({ status: 'REJECTED', reviewNote: 'Commercial access remains approved', activeSlot: null });
    expect(f.db.user.update).not.toHaveBeenCalled();
  });

  it('keeps the internal reason private from the affected account and other ancestors', async () => {
    const f = fixture(); f.users[0].dealerMode = 'INTERNAL'; f.users[1].dealerMode = 'INTERNAL';
    await f.service.requestSuspension(3, true, actor(2), note);
    for (const viewer of [actor(1), actor(3), actor(99, 'operator')]) {
      const response = presentApiResponse(await f.service.list(viewer), viewer);
      expect(JSON.stringify(response)).not.toContain(note);
      expect(response.members.find((member: any) => member.id === 3)).toMatchObject({ businessAction: null, canReviewSuspension: false });
    }
  });

  it('allows one pending request, and only its author can withdraw it', async () => {
    const f = fixture(); f.users[0].dealerMode = 'INTERNAL';
    const request = await f.service.requestSuspension(2, true, actor(1), note);
    await expect(f.service.requestSuspension(2, true, actor(1), note)).rejects.toThrow(ConflictException);
    await expect(f.service.withdrawSuspension(request.id, actor(4))).rejects.toThrow(NotFoundException);
    await f.service.withdrawSuspension(request.id, actor(1));
    expect(f.actions[0]).toMatchObject({ status: 'WITHDRAWN', activeSlot: null });
    await expect(f.service.reviewSuspension(request.id, true, actor(99, 'admin'))).rejects.toThrow(ConflictException);
    await expect(f.service.requestSuspension(2, true, actor(1), note)).resolves.toMatchObject({ status: 'PENDING' });
    expect(f.users[1].networkSuspended).toBe(false);
  });

  it('does not apply a stale pending request after an administrator makes a direct decision', async () => {
    const f = fixture(); f.users[0].dealerMode = 'INTERNAL';
    const request = await f.service.requestSuspension(2, true, actor(1), note);
    await f.service.setSuspension(2, true, actor(99, 'admin'), 'Administrative review');
    expect(f.actions[0]).toMatchObject({ status: 'SUPERSEDED', activeSlot: null });
    await f.service.setSuspension(2, false, actor(99, 'admin'), 'Resolved by administration');
    await expect(f.service.reviewSuspension(request.id, true, actor(99, 'admin'))).rejects.toThrow(ConflictException);
    expect(f.users[1].networkSuspended).toBe(false);
  });

  it('prevents an external superior from lifting an administrative pause but lets it request resumption', async () => {
    const f = fixture();
    await f.service.setSuspension(2, true, actor(99, 'admin'), note);
    await expect(f.service.setSuspension(2, false, actor(1), note)).rejects.toThrow(ForbiddenException);
    const member = (await f.service.list(actor(1))).members.find(member => member.id === 2)!;
    expect(member).toMatchObject({ canSuspend: false, canRequestSuspension: true });
    const request = await f.service.requestSuspension(2, false, actor(1), 'Resolved with customer');
    expect(f.users[1].networkSuspended).toBe(true);
    await f.service.reviewSuspension(request.id, true, actor(99, 'admin'));
    expect(f.users[1]).toMatchObject({ networkSuspended: false, networkSuspendedByAdmin: false });
  });

  it('lets an administrator pause a top-level dealer and blocks new pricing throughout that branch', async () => {
    const f = fixture();
    await f.service.setSuspension(1, true, actor(99, 'admin'), note);
    for (const owner of f.users.slice(0, 3)) {
      await expect(createNetworkSnapshot(f.db, owner, '.07')).rejects.toThrow(BadRequestException);
      await expect(accountNetworkBlocked(f.db, owner, true)).resolves.toBe(true);
      await expect(accountNetworkBlocked(f.db, owner)).resolves.toBe(false);
    }
    expect(f.users[3].networkSuspended).toBe(false);
  });

  it('does not approve a request for an administratively disabled account but permits declining it', async () => {
    const f = fixture(); f.users[0].dealerMode = 'INTERNAL';
    const request = await f.service.requestSuspension(2, true, actor(1), note);
    f.users[1].isActive = false;
    await expect(f.service.reviewSuspension(request.id, true, actor(99, 'admin'))).rejects.toThrow(ForbiddenException);
    await f.service.reviewSuspension(request.id, false, actor(99, 'admin'), 'Account disabled separately');
    expect(f.users[1].isActive).toBe(false);
  });
});
