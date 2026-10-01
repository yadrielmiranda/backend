import type { AuthUser } from '@/auth/types/auth-user.type';
import { canShareEstimate } from './estimate-share-access';

describe('Estimate sharing access', () => {
  const parents = new Map<number, number | null>([
    [1, null], [2, 1], [3, 1], [4, 2], [5, 2], [6, null],
  ]);
  const estimate = (ownerId = 4, role = 'dealer') => ({
    idUser: ownerId,
    user: { role: { name: role } },
  });
  const actor = (id: number, name: NonNullable<AuthUser['role']>['name'] = 'dealer'): AuthUser => ({
    id, role: { name },
  });
  const db = {
    user: {
      findUnique: jest.fn(async ({ where: { id } }) => {
        if (!parents.has(id)) return null;
        const parentDealerId = parents.get(id)!;
        return {
          parentDealerId,
          parentDealer: parentDealerId == null ? null : {
            parentDealerId: parents.get(parentDealerId),
          },
        };
      }),
    },
  };

  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['owner', actor(4)],
    ['parent', actor(2)],
    ['grandparent', actor(1)],
    ['admin', actor(99, 'admin')],
  ])('allows the %s through the existing owner-access policy', async (_label, user) => {
    await expect(canShareEstimate(db as any, estimate(), user)).resolves.toBe(true);
  });

  it.each([
    ['unrelated dealer', actor(6)],
    ['sibling dealer', actor(5)],
    ['other branch', actor(3)],
    ['operator', actor(99, 'operator')],
    ['client', actor(99, 'client')],
    ['technician', actor(99, 'technician')],
    ['missing role', { id: 4 }],
  ])('denies the %s', async (_label, user) => {
    await expect(canShareEstimate(db as any, estimate(), user)).resolves.toBe(false);
  });

  it('does not let a descendant share an ancestor estimate', async () => {
    await expect(canShareEstimate(db as any, estimate(2), actor(4))).resolves.toBe(false);
  });

  it.each(['operator', 'client', 'technician'] as const)(
    'does not let a %s bypass the role check by matching the owner ID',
    async (role) => {
      await expect(canShareEstimate(db as any, estimate(), actor(4, role))).resolves.toBe(false);
      expect(db.user.findUnique).not.toHaveBeenCalled();
    },
  );

  it('limits admins to dealer-owned estimates and rejects missing estimates', async () => {
    await expect(canShareEstimate(db as any, estimate(4, 'client'), actor(99, 'admin'))).resolves.toBe(false);
    await expect(canShareEstimate(db as any, null, actor(99, 'admin'))).resolves.toBe(false);
  });
});
