import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateProfileDto } from '@/auth/dto/update-profile.dto';
import { CreateNetworkMemberDto } from '@/dealer-network/dealer-network.dto';
import { BrandingsService } from '@/brandings/brandings.service';
import { CreateBrandingDto } from '@/brandings/dto/create-branding.dto';
import { presentApiResponse } from '@/common/response-privacy.interceptor';

jest.mock('bcrypt', () => ({ hash: jest.fn(async () => 'test-only-hash') }));

const personal = {
  username: 'address-user', firstName: 'Address', lastName: 'User',
  email: 'address@example.test', phone: '+13055550111', password: 'Example-password-123',
  street: '100 Original Street', city: 'Miami', state: 'FL', postalCode: '33101', idRole: 2,
};

function accountFixture() {
  let account: any = { ...personal, id: 7, role: { name: 'client' }, dealerMode: null, deletedAt: null };
  const select = (row: any, fields: any) => Object.fromEntries(Object.keys(fields).map(key => [key, row[key]]));
  const db: any = {
    $queryRaw: jest.fn(async () => []),
    role: { findUnique: jest.fn(async () => ({ id: 2, name: 'client' })) },
    user: {
      findFirst: jest.fn(async ({ select: fields }) => fields ? select(account, fields) : { ...account }),
      findUniqueOrThrow: jest.fn(async () => ({ ...account })),
      create: jest.fn(async ({ data, select: fields }) => {
        account = { ...account, ...data, role: { name: 'client' } };
        return select(account, fields);
      }),
      update: jest.fn(async ({ data, select: fields }) => {
        account = { ...account, ...data };
        return select(account, fields);
      }),
    },
  };
  db.$transaction = jest.fn(async work => work(db));
  return { db, service: new UsersService(db, { log: jest.fn() } as any) };
}

describe('Optional account and branding address details', () => {
  it('persists and returns details separately from the street and supports omission versus clearing', async () => {
    const { db, service } = accountFixture();
    const created = await service.createUser({ ...personal, addressLine2: '  Apartment 4B  ' });
    expect(created).toMatchObject({ street: personal.street, addressLine2: 'Apartment 4B' });
    expect(presentApiResponse(created, { id: 7, role: { name: 'client' } }).addressLine2).toBe('Apartment 4B');
    const preserved = await service.updateUser({ where: { id: 7 }, data: { firstName: 'Changed' } });
    expect(preserved.addressLine2).toBe('Apartment 4B');
    expect(db.user.update.mock.calls.at(-1)[0].data).not.toHaveProperty('addressLine2');
    expect((await service.updateUser({ where: { id: 7 }, data: { addressLine2: '  ' } })).addressLine2).toBeNull();
    await service.updateUser({ where: { id: 7 }, data: { addressLine2: 'Unit 9' } });
    const cleared = await service.updateUser({ where: { id: 7 }, data: { addressLine2: null } });
    expect(cleared).toMatchObject({ street: personal.street, addressLine2: null });
  });

  it.each([123, false, 'x'.repeat(151)])('rejects invalid details in direct account updates: %j', async addressLine2 => {
    const { db, service } = accountFixture();
    await expect(service.updateUser({ where: { id: 7 }, data: { addressLine2 } as any })).rejects.toThrow(BadRequestException);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it.each(['company', 'dealer'])('round trips %s branding with optional, trimmed and clearable details', async kind => {
    let row: any = null;
    const branding = {
      findFirst: jest.fn(async () => row),
      create: jest.fn(async ({ data }) => row = { id: 1, ...data }),
      update: jest.fn(async ({ data }) => {
        row = { ...row, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) };
        return { ...row };
      }),
    };
    const service = new BrandingsService({ branding } as any);
    const create = (dto: CreateBrandingDto) => kind === 'company' ? service.createCompanyBranding(dto) : service.createDealerBranding(7, dto);
    const update = (dto: Partial<CreateBrandingDto>) => kind === 'company' ? service.updateCompanyBranding(dto) : service.updateDealerBranding(7, dto);
    expect(await create({ name: 'Test', street: personal.street, addressLine2: ' Suite 2 ' })).toMatchObject({ street: personal.street, addressLine2: 'Suite 2' });
    expect((await update({ name: 'Updated' })).addressLine2).toBe('Suite 2');
    expect((await update({ addressLine2: '' })).addressLine2).toBeNull();
    expect((await update({ addressLine2: ' Building C ' })).addressLine2).toBe('Building C');
    expect((await update({ addressLine2: null })).addressLine2).toBeNull();
    expect(row.street).toBe(personal.street);
  });

  const pipe = new ValidationPipe({ transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true } });
  for (const metatype of [CreateUserDto, UpdateProfileDto, CreateNetworkMemberDto, CreateBrandingDto]) {
    it(`${metatype.name} accepts optional details and validates their original type and length`, async () => {
      const payload = { ...personal, markupPercent: 20, name: 'Test' };
      for (const [value, expected] of [[undefined, undefined], [null, null], ['', null], [' Suite 2 ', 'Suite 2'], ['x'.repeat(150), 'x'.repeat(150)]]) {
        const result = await pipe.transform({ ...payload, ...(value === undefined ? {} : { addressLine2: value }) }, { type: 'body', metatype });
        expect(result.addressLine2).toBe(expected);
      }
      for (const addressLine2 of [false, 123, {}, 'x'.repeat(151)]) {
        await expect(pipe.transform({ ...payload, addressLine2 }, { type: 'body', metatype })).rejects.toThrow(BadRequestException);
      }
    });
  }
});
