import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateProfileDto } from '@/auth/dto/update-profile.dto';
import { RegisterUserDto } from '@/auth/dto/register-user.dto';
import { UsersController } from './users.controller';
import { ROLES_KEY } from '@/auth/roles.decorator';

jest.mock('bcrypt', () => ({ hash: jest.fn(async () => 'test-only-hash') }));

function fixture(roleName = 'dealer') {
  const account: any = {
    id: 7,
    idRole: 2,
    role: { name: roleName },
    dealerMode: 'EXTERNAL',
    noInstallationDeposit: false,
    phone: '+13055550111',
  };
  const tx = {
    $queryRaw: jest.fn(),
    user: {
      findFirst: jest.fn(async () => ({ ...account })),
      findUniqueOrThrow: jest.fn(async () => account),
      create: jest.fn(async ({ data }) => ({ ...account, ...data })),
      update: jest.fn(async ({ data }) => Object.assign(account, data)),
    },
    role: { findUnique: jest.fn(async () => ({ id: 2, name: roleName })) },
  };
  const prisma: any = {
    ...tx,
    $transaction: jest.fn(async (work) => work(tx)),
  };
  const logs = { log: jest.fn() };
  return {
    account,
    tx,
    logs,
    service: new UsersService(prisma, logs as never),
  };
}

describe('Admin-managed No installation deposit setting', () => {
  it('persists the setting and records the change in the existing user audit', async () => {
    const f = fixture();
    await f.service.updateUserAsAdmin(
      7,
      { noInstallationDeposit: true },
      { id: 1, role: { name: 'admin' } },
    );
    expect(f.account.noInstallationDeposit).toBe(true);
    expect(f.logs.log).toHaveBeenCalledWith(
      expect.objectContaining({
        before: expect.objectContaining({ noInstallationDeposit: false }),
        after: expect.objectContaining({ noInstallationDeposit: true }),
        meta: expect.objectContaining({
          changedFields: ['noInstallationDeposit'],
        }),
      }),
    );
  });

  it.each(['INTERNAL', 'EXTERNAL'] as const)(
    'supports a new %s dealer',
    async (dealerMode) => {
      const f = fixture();
      const saved = await f.service.createUser({
        idRole: 2,
        password: 'test',
        dealerMode,
        noInstallationDeposit: true,
      } as CreateUserDto);
      expect(saved.noInstallationDeposit).toBe(true);
      expect(saved.dealerMode).toBe(dealerMode);
    },
  );

  it('keeps the setting unchanged when saving unrelated profile data', async () => {
    const f = fixture();
    f.account.noInstallationDeposit = true;
    await f.service.updateUser({
      where: { id: 7 },
      data: { firstName: 'Dealer' },
    });
    expect(f.account.noInstallationDeposit).toBe(true);
    expect(f.tx.user.update.mock.calls[0][0].data).not.toHaveProperty(
      'noInstallationDeposit',
    );
  });

  it('lets admin remove the exemption', async () => {
    const f = fixture();
    f.account.noInstallationDeposit = true;
    await f.service.updateUser({
      where: { id: 7 },
      data: { noInstallationDeposit: false },
    });
    expect(f.account.noInstallationDeposit).toBe(false);
  });

  it('clears the exemption if admin changes the role to client', async () => {
    const f = fixture();
    f.account.noInstallationDeposit = true;
    f.tx.role.findUnique.mockResolvedValueOnce({ id: 3, name: 'client' });
    await f.service.updateUser({ where: { id: 7 }, data: { idRole: 3 } });
    expect(f.account.noInstallationDeposit).toBe(false);
    expect(f.account.dealerMode).toBeNull();
  });

  it.each(['client', 'admin', 'operator'])(
    'never enables the setting for a %s account',
    async (role) => {
      const f = fixture(role);
      const saved = await f.service.createUser({
        idRole: 2,
        password: 'test',
        noInstallationDeposit: true,
      } as CreateUserDto);
      expect(saved.noInstallationDeposit).toBe(false);
    },
  );

  it.each([RegisterUserDto, UpdateProfileDto])(
    'rejects self-assigned exemption and dealer mode in %p',
    (Dto) => {
      const data = plainToInstance(Dto as typeof UpdateProfileDto, {
        noInstallationDeposit: true,
        dealerMode: 'INTERNAL',
      });
      const errors = validateSync(data, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(errors.map((error) => error.property)).toEqual(
        expect.arrayContaining(['noInstallationDeposit', 'dealerMode']),
      );
    },
  );

  it('requires a boolean on the admin endpoint', () => {
    expect(
      validateSync(
        plainToInstance(UpdateUserDto, { noInstallationDeposit: true }),
      ),
    ).toEqual([]);
    expect(
      validateSync(
        plainToInstance(UpdateUserDto, { noInstallationDeposit: 'false' }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'noInstallationDeposit' }),
      ]),
    );
    expect(
      Reflect.getMetadata(ROLES_KEY, UsersController.prototype.updateUser),
    ).toEqual(['admin']);
    expect(
      Reflect.getMetadata(ROLES_KEY, UsersController.prototype.createUser),
    ).toEqual(['admin']);
  });
});
