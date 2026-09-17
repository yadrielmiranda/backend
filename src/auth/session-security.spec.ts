import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './guards/auth/jwt.strategy';
import { validateAccessSession, SessionTokenPayload } from './access-session';

const secret = 'isolated-regression-test-secret';

async function fixture() {
  const account: any = { id: 7, username: 'account', firstName: 'Test', lastName: 'User', email: 'test@example.test',
    password: await bcrypt.hash('Old-password-123', 4), passwordUpdatedAt: new Date(Date.now() - 60000),
    isActive: true, deletedAt: null, role: { name: 'admin' } };
  const sessions = new Map<string, any>();
  const matches = (s: any, where: any) => (!where.id || s.id === where.id) &&
    (!where.userId || s.userId === where.userId) && (!where.NOT?.id || s.id !== where.NOT.id) &&
    (where.revokedAt !== null || s.revokedAt === null) &&
    (!where.refreshTokenHash || s.refreshTokenHash === where.refreshTokenHash) &&
    (!where.expiresAt?.gt || s.expiresAt > where.expiresAt.gt);
  const db: any = { user: { findUnique: jest.fn(async () => account) }, session: {
    create: jest.fn(async ({ data }) => { const s = { revokedAt: null, ip: null, userAgent: null, ...data }; sessions.set(s.id, s); return s; }),
    findUnique: jest.fn(async ({ where }) => { const s = sessions.get(where.id); return s ? { ...s, user: account } : null; }),
    findMany: jest.fn(async ({ where }) => [...sessions.values()].filter(s => matches(s, where))),
    update: jest.fn(async ({ where, data }) => Object.assign(sessions.get(where.id), data)),
    updateMany: jest.fn(async ({ where, data }) => { const found = [...sessions.values()].filter(s => matches(s, where));
      found.forEach(s => Object.assign(s, data)); return { count: found.length }; }),
  } };
  const users: any = {
    userWithPassword: jest.fn(async () => ({ ...account })),
    findOneByIdentifier: jest.fn(async () => account),
    updateUser: jest.fn(async ({ data }) => { account.password = await bcrypt.hash(data.password, 4);
      account.passwordUpdatedAt = new Date(); return account; }),
  };
  const jwt = new JwtService({ secret });
  const service = new AuthService(users, db, jwt, { log: jest.fn() } as any, {} as any, {} as any);
  (service as any).bcryptRounds = 4;
  const sid = service.newSessionId();
  const refresh = await service.signRefreshToken(account.id, sid, account.passwordUpdatedAt);
  await service.createSession({ sessionId: sid, userId: account.id, refreshToken: refresh });
  const access = await service.signAccessToken(account, sid);
  const validate = (token = access) => validateAccessSession(db, jwt.verify<SessionTokenPayload>(token));
  return { account, sessions, db, users, service, jwt, sid, refresh, access, validate };
}

describe('Session security (H02)', () => {
  const oldIdle = process.env.SESSION_IDLE_MINUTES;
  beforeEach(() => { process.env.SESSION_IDLE_MINUTES = '0'; });
  afterEach(() => { if (oldIdle === undefined) delete process.env.SESSION_IDLE_MINUTES; else process.env.SESSION_IDLE_MINUTES = oldIdle; });

  it('authenticates a valid access token against its stored session', async () => {
    const f = await fixture();
    expect(await f.validate()).toMatchObject({ id: 7, sessionId: f.sid, role: { name: 'admin' } });
  });

  it('rejects a correctly signed refresh token in the real Passport access strategy', async () => {
    const f = await fixture();
    const strategy: any = new JwtStrategy({ get: () => secret } as any, f.db);
    const attempt = new Promise((resolve, reject) => {
      strategy.success = resolve; strategy.fail = reject; strategy.error = reject;
      strategy.authenticate({ cookies: { access_token: f.refresh } });
    });
    await expect(attempt).rejects.toThrow('Invalid session token');
  });

  it.each(['client', 'dealer', 'operator'])('uses the current %s role instead of the old admin claim', async role => {
    const f = await fixture(); f.account.role.name = role;
    expect((await f.validate()).role?.name).toBe(role);
  });

  it.each(['revoked', 'expired', 'missing', 'wrong-owner', 'disabled', 'deleted', 'password-changed'])('rejects %s even with no refresh cookie and idle disabled', async condition => {
    const f = await fixture(); const session = f.sessions.get(f.sid);
    if (condition === 'revoked') session.revokedAt = new Date();
    if (condition === 'expired') session.expiresAt = new Date(Date.now() - 1);
    if (condition === 'missing') f.sessions.delete(f.sid);
    if (condition === 'wrong-owner') session.userId = 8;
    if (condition === 'disabled') f.account.isActive = false;
    if (condition === 'deleted') f.account.deletedAt = new Date();
    if (condition === 'password-changed') f.account.passwordUpdatedAt = new Date(f.account.passwordUpdatedAt.getTime() + 1);
    await expect(f.validate()).rejects.toThrow();
  });

  it('rejects legacy and incomplete access tokens instead of falling back to stateless authentication', async () => {
    const f = await fixture();
    for (const payload of [{ sub: 7, role: 'admin' }, { sub: 7, sid: f.sid, tokenType: 'access' }]) {
      await expect(f.validate(f.jwt.sign(payload, { expiresIn: '15m' }))).rejects.toThrow('Invalid session token');
    }
  });

  it('enforces idle expiration directly from the access session', async () => {
    const f = await fixture(); process.env.SESSION_IDLE_MINUTES = '10';
    f.sessions.get(f.sid).lastUsedAt = new Date(Date.now() - 11 * 60_000);
    await expect(f.validate()).rejects.toThrow('inactivity');
  });

  it('logout revokes the access session even when the refresh cookie is absent', async () => {
    const f = await fixture(); const controller = new AuthController(f.service, f.users);
    const clearCookie = jest.fn();
    await controller.logout({ user: await f.validate(), cookies: {} } as any, { clearCookie } as any);
    expect(clearCookie).toHaveBeenCalledTimes(2);
    await expect(f.validate()).rejects.toThrow('revoked');
    await expect(f.service.refreshFromToken(f.refresh)).rejects.toThrow('revocada');
  });

  it('refresh accepts only refresh tokens and does not revoke a session for an access-token substitution', async () => {
    const f = await fixture();
    await expect(f.service.refreshFromToken(f.access)).rejects.toThrow('Invalid session token');
    expect(f.sessions.get(f.sid).revokedAt).toBeNull();
  });

  it('renews concurrent tabs and SSR requests without invalidating the browser refresh credential', async () => {
    const f = await fixture();
    const expiry = f.sessions.get(f.sid).expiresAt.getTime();
    const results = await Promise.all([f.service.refreshFromToken(f.refresh), f.service.refreshFromToken(f.refresh)]);
    for (const next of results) {
      expect(next.newRefreshToken).toBe(f.refresh);
      await expect(f.validate(next.accessToken)).resolves.toMatchObject({ id: 7 });
    }
    expect(f.sessions.get(f.sid).expiresAt.getTime()).toBe(expiry);
    await expect(f.service.refreshFromToken(f.refresh)).resolves.toHaveProperty('accessToken');
  });

  it('checks the entire stored refresh credential, including differences beyond bcrypt’s 72-byte limit', async () => {
    const f = await fixture();
    const other = await f.service.signRefreshToken(7, f.sid, f.account.passwordUpdatedAt);
    expect(other).not.toBe(f.refresh);
    const digest = (s: string) => createHash('sha256').update(s).digest('hex');
    const hash = f.sessions.get(f.sid).refreshTokenHash;
    expect(await bcrypt.compare(digest(f.refresh), hash)).toBe(true);
    expect(await bcrypt.compare(digest(other), hash)).toBe(false);
    await expect(f.service.refreshFromToken(other)).rejects.toThrow('inválido');
  });

  it('does not issue refreshed credentials after a concurrent revocation', async () => {
    const f = await fixture(); f.db.session.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(f.service.refreshFromToken(f.refresh)).rejects.toThrow('Session changed');
  });

  it('a password change revokes old sessions and issues a new valid session for the current browser', async () => {
    const f = await fixture();
    const result = await f.service.changePasswordSelf(7, { currentPassword: 'Old-password-123', newPassword: 'New-password-456' }, f.refresh);
    expect(result.accessToken).toBeTruthy(); expect(result.refreshToken).toBeTruthy();
    const actor = await f.validate(result.accessToken!);
    expect(actor.sessionId).not.toBe(f.sid);
    await expect(f.validate()).rejects.toThrow();
    await expect(f.service.refreshFromToken(result.refreshToken!)).resolves.toHaveProperty('accessToken');
  });

  it('changing a password never revives a previously revoked refresh session', async () => {
    const f = await fixture(); f.sessions.get(f.sid).revokedAt = new Date();
    const result = await f.service.changePasswordSelf(7, { currentPassword: 'Old-password-123', newPassword: 'New-password-456' }, f.refresh);
    expect(result.accessToken).toBeUndefined(); expect(f.sessions.size).toBe(1);
    expect(f.sessions.get(f.sid).revokedAt).not.toBeNull();
  });

  it('rejects a wrong current password without changing credentials or sessions', async () => {
    const f = await fixture();
    await expect(f.service.changePasswordSelf(7, { currentPassword: 'Incorrect', newPassword: 'New-password-456' }, f.refresh)).rejects.toThrow('incorrecta');
    expect(f.users.updateUser).not.toHaveBeenCalled();
    await expect(f.validate()).resolves.toHaveProperty('id', 7);
  });
});
