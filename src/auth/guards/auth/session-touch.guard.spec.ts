import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { SessionTouchGuard } from './session-touch.guard';

describe('Session touches within the same millisecond', () => {
  const user = { id: 7, sessionId: 'test-session' };
  const context = new ExecutionContextHost([{ user, method: 'PATCH' }], SessionTouchGuard, SessionTouchGuard.prototype.canActivate);

  it.each([true, false])('rechecks a zero-row update with an active session=%s', async (active) => {
    const session = {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findFirst: jest.fn().mockResolvedValue(active ? { id: user.sessionId } : null),
    };
    const guard = new SessionTouchGuard({ session } as never, new Reflector());
    const result = guard.canActivate(context);
    if (active) await expect(result).resolves.toBe(true);
    else await expect(result).rejects.toThrow(UnauthorizedException);
    const writtenAt = session.updateMany.mock.calls[0][0].data.lastUsedAt;
    expect(session.findFirst).toHaveBeenCalledWith({
      where: {
        id: user.sessionId, userId: user.id, revokedAt: null,
        lastUsedAt: { gte: writtenAt }, expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true },
    });
  });
});
