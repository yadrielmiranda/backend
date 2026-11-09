import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Prisma } from '@prisma/client';
import { UpdateRoleDto } from './dto/update-role.dto';
import { parseRoleMarkup } from './role-markup';
import { RolesService } from './roles.service';

function fixture() {
  const current = {
    id: 2, name: 'client', markup: new Prisma.Decimal('0.7551'),
    paymentPlanId: null, installationPriceProfileId: null,
  };
  const db = {
    role: {
      findUnique: jest.fn(async () => ({ ...current })),
      findMany: jest.fn(async () => [{ ...current }]),
      update: jest.fn(async ({ data }) => {
        if (data.markup !== undefined) current.markup = data.markup;
        return { ...current };
      }),
    },
  };
  const logs = { log: jest.fn(async () => undefined) };
  const service = new RolesService(db as any, logs as any);
  const actor = { id: 1, role: { name: 'admin' } } as any;
  return { current, db, logs, service, actor };
}

describe('Exact role markup input and persistence', () => {
  it.each([
    ['0.755125', '0.755125'],
    ['0.123456789012345678', '0.123456789012345678'],
    ['-0.123456789012345678', '-0.123456789012345678'],
    ['999999.999999999999999999', '999999.999999999999999999'],
    ['-999999.999999999999999999', '-999999.999999999999999999'],
    [' 0.15 ', '0.15'],
    [0.755125, '0.755125'],
    [-0.15, '-0.15'],
    [1e-18, '0.000000000000000001'],
    [0, '0'],
  ])('accepts decimal strings and legacy numeric payload %s', (markup, expected) => {
    const dto = plainToInstance(UpdateRoleDto, { markup });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.markup).toBe(expected);
    expect(parseRoleMarkup(dto.markup).toFixed()).toBe(expected);
  });

  it.each([null, '', ' ', true, {}, [], NaN, Infinity, 1e-19,
    '1000000', '-1000000', '0.1234567890123456789', '1e-8', '0.5x'])
  ('rejects invalid or excessive precision %s instead of rounding it', markup => {
    const dto = plainToInstance(UpdateRoleDto, { markup });
    expect(validateSync(dto).length).toBeGreaterThan(0);
    expect(() => parseRoleMarkup(markup)).toThrow();
  });

  it('stores, returns and audits 75.5125 percent without passing it through a number', async () => {
    const f = fixture();
    const dto = plainToInstance(UpdateRoleDto, { markup: '0.755125' });
    const result = await f.service.update(2, dto, f.actor);
    expect(f.db.role.update.mock.calls[0][0].data.markup).toBeInstanceOf(Prisma.Decimal);
    expect(result.markup.toString()).toBe('0.755125');
    expect(JSON.parse(JSON.stringify(await f.service.findAll()))[0].markup).toBe('0.755125');
    const audit = (f.logs.log.mock.calls as any)[0][0];
    expect(audit.before.markup).toBe('0.7551');
    expect(audit.after.markup).toBe('0.755125');
    expect(audit.meta.changedFields).toContain('markup');
  });

  it.each([{ paymentPlanId: null }, { installationPriceProfileId: null }])
  ('changes other role settings without replacing the existing exact markup (%j)', async input => {
    const f = fixture();
    f.current.markup = new Prisma.Decimal('0.123456789012345678');
    const dto = plainToInstance(UpdateRoleDto, input);
    expect(validateSync(dto)).toHaveLength(0);
    const result = await f.service.update(2, dto, f.actor);
    expect(f.db.role.update.mock.calls[0][0].data).not.toHaveProperty('markup');
    expect(result.markup.toString()).toBe('0.123456789012345678');
    expect((f.logs.log.mock.calls as any)[0][0].meta.changedFields).not.toContain('markup');
  });

  it('guards service callers against silent database rounding too', async () => {
    const f = fixture();
    await expect(f.service.update(2, { markup: '0.1234567890123456789' }, f.actor)).rejects.toThrow(/18 decimal/);
    expect(f.db.role.update).not.toHaveBeenCalled();
    expect(f.logs.log).not.toHaveBeenCalled();
  });
});
