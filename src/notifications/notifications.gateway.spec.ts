import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import { PrismaService } from '@/prisma/prisma.service';
import { NotificationsModule } from './notifications.module';
import { NotificationsGateway } from './notifications.gateway';

const TEST_SECRET = 'notifications-test-secret-not-for-production';
const signer = new JwtService({ secret: TEST_SECRET });
const passwordVersion = new Date('2026-01-01T12:00:00.123Z');
const sessions = new Map<string, any>();
const sessionId = (id: number) => `20000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const access = (id: number, extra: Record<string, unknown> = {}) => signer.sign({
  sub: id, sid: sessionId(id), tokenType: 'access', passwordVersion: passwordVersion.getTime(), ...extra,
}, { expiresIn: '15m' });
const db = { session: { findUnique: async ({ where }: any) => {
  if (!sessions.has(where.id)) {
    const id = Number(where.id.slice(-12));
    sessions.set(where.id, { id: where.id, userId: id, revokedAt: null, expiresAt: new Date(Date.now() + 86400000),
      lastUsedAt: new Date(), user: { id, username: 'User', isActive: true, deletedAt: null,
        passwordUpdatedAt: passwordVersion, role: { name: 'client' } } });
  }
  return sessions.get(where.id);
} } };

function client(id: string, token?: string) {
  return {
    id,
    data: {} as { userId?: number },
    handshake: { headers: { cookie: token ? `access_token=${token}` : '' } },
    disconnect: jest.fn(),
  };
}

function createModule(secret: string | undefined = TEST_SECRET) {
  return Test.createTestingModule({ imports: [NotificationsModule] })
    .overrideProvider(ConfigService)
    .useValue({
      get: (key: string) => (key === 'JWT_SECRET_KEY' ? secret : undefined),
    })
    .overrideProvider(PrismaService)
    .useValue(db)
    .compile();
}

describe('NotificationsGateway authentication', () => {
  let module: TestingModule;
  let gateway: NotificationsGateway;
  let emit: jest.Mock;
  let to: jest.Mock;

  beforeEach(async () => {
    sessions.clear();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    // Usa el módulo real para detectar una configuración JWT ausente.
    module = await createModule();
    gateway = module.get(NotificationsGateway);
    emit = jest.fn();
    to = jest.fn(() => ({ emit }));
    gateway.server = { to } as never;
  });

  afterEach(async () => {
    await module?.close();
    jest.restoreAllMocks();
  });

  it('accepts a login token signed with JWT_SECRET_KEY and delivers its notification', async () => {
    const socket = client(
      'client-browser',
      access(7),
    );
    const notification = {
      id: 360,
      recipientId: 7,
      message: 'Order status updated.',
    };

    await gateway.handleConnection(socket as unknown as Socket);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data.userId).toBe(7);

    await gateway.sendNotificationToUser(7, notification);
    expect(to).toHaveBeenCalledWith('client-browser');
    expect(emit).toHaveBeenCalledWith('new_notification', notification);
  });

  it.each([
    ['missing cookie', undefined],
    ['refresh token', access(7, { tokenType: 'refresh' })],
    ['legacy token', signer.sign({ sub: 7 }, { expiresIn: '15m' })],
    ['malformed token', 'not-a-jwt'],
    [
      'incorrect signature',
      new JwtService({ secret: 'different-test-secret' }).sign({ sub: 7 }),
    ],
    ['expired token', signer.sign({ sub: 7 }, { expiresIn: -1 })],
    ['missing user', signer.sign({})],
    ['invalid user', signer.sign({ sub: 'invalid' })],
  ])('rejects %s without registering the socket', async (_label, token) => {
    const socket = client('rejected-browser', token);

    await gateway.handleConnection(socket as unknown as Socket);
    expect(socket.disconnect).toHaveBeenCalledWith(true);

    await gateway.sendNotificationToUser(7, { id: 360 });
    expect(to).not.toHaveBeenCalled();
  });

  it('delivers to both devices for the recipient and keeps the remaining device after disconnect', async () => {
    const first = client('device-one', access(7));
    const second = client('device-two', access(7));
    const other = client('other-user', access(8));
    for (const socket of [first, second, other]) {
      await gateway.handleConnection(socket as unknown as Socket);
    }

    await gateway.sendNotificationToUser(7, { id: 360 });
    expect(to.mock.calls.map(([id]) => id)).toEqual([
      'device-one',
      'device-two',
    ]);
    expect(emit).toHaveBeenCalledTimes(2);

    gateway.handleDisconnect(first as unknown as Socket);
    to.mockClear();
    emit.mockClear();
    await gateway.sendNotificationToUser(7, { id: 361 });
    expect(to.mock.calls.map(([id]) => id)).toEqual(['device-two']);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it.each(['revoked', 'password-changed', 'inactive'])('stops an already-open socket when its session becomes %s', async condition => {
    const socket = client('open-browser', access(7));
    await gateway.handleConnection(socket as unknown as Socket);
    const session = sessions.get(sessionId(7));
    if (condition === 'revoked') session.revokedAt = new Date();
    if (condition === 'password-changed') session.user.passwordUpdatedAt = new Date(passwordVersion.getTime() + 1);
    if (condition === 'inactive') session.user.isActive = false;
    await gateway.sendNotificationToUser(7, { id: 360 });
    expect(emit).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('rejects a connection to an already-revoked session', async () => {
    await db.session.findUnique({ where: { id: sessionId(7) } });
    sessions.get(sessionId(7)).revokedAt = new Date();
    const socket = client('revoked-browser', access(7));
    await gateway.handleConnection(socket as unknown as Socket);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    await gateway.sendNotificationToUser(7, { id: 360 });
    expect(emit).not.toHaveBeenCalled();
  });

  it('fails initialization when JWT_SECRET_KEY is empty', async () => {
    await expect(createModule('')).rejects.toThrow(
      'JWT_SECRET_KEY is not set in .env',
    );
  });
});
