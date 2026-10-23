import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GlobalParameterKey, Prisma } from '@prisma/client';
import { GlobalParametersService } from './global-parameters.service';

describe('GlobalParametersService', () => {
  const threshold = GlobalParameterKey.MATERIAL_ONLY_UPFRONT_THRESHOLD;
  let service: GlobalParametersService;
  let prisma: any;

  beforeEach(() => {
    prisma = { globalParameter: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ key: threshold }),
      update: jest.fn().mockImplementation(async ({ where, data }) => ({ ...where, ...data })),
    } };
    service = new GlobalParametersService(prisma);
  });

  it.each(['0', '1', '1250.50', '999999.99'])(
    'stores the configured threshold %s exactly, including zero to disable', async (value) => {
      const saved = await service.update(threshold, { value });
      expect(saved.value.equals(new Prisma.Decimal(value))).toBe(true);
      expect(saved.unit).toBe('USD');
      expect(prisma.globalParameter.update).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['', ' ', 'NaN', 'Infinity', '-Infinity', '-0.01', '1.001', '999999.999', '1000000', '1e2', '12abc', '1,000'])(
    'rejects invalid monetary threshold %s without saving', async (value) => {
      await expect(service.update(threshold, { value })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.globalParameter.update).not.toHaveBeenCalled();
    },
  );

  it('rejects a currency other than USD', async () => {
    await expect(service.update(threshold, { value: '250', unit: 'EUR' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.globalParameter.update).not.toHaveBeenCalled();
  });

  it('preserves precision rules for unrelated percentage parameters', async () => {
    const saved = await service.update(GlobalParameterKey.SALES_TAX, { value: '0.0725' });
    expect(saved.value.toString()).toBe('0.0725');
  });

  it('lists all parameters in the existing order for administrators', async () => {
    await service.findAll(true);
    expect(prisma.globalParameter.findMany).toHaveBeenCalledWith({ orderBy: { key: 'asc' } });
  });

  it.each([undefined, false])('excludes the internal threshold for other readers (%s)', async (includeInternal) => {
    await service.findAll(includeInternal);
    expect(prisma.globalParameter.findMany).toHaveBeenCalledWith({
      where: { key: { not: threshold } }, orderBy: { key: 'asc' },
    });
  });

  it('does not silently create a missing parameter', async () => {
    prisma.globalParameter.findUnique.mockResolvedValue(null);
    await expect(service.update(threshold, { value: '100' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.globalParameter.update).not.toHaveBeenCalled();
  });

  it('still routes delivery pricing to its dedicated settings', async () => {
    await expect(service.update(GlobalParameterKey.DELIVERY_BASE_PRICE, { value: '200' })).rejects.toThrow('Settings > Warehouse & Delivery');
    expect(prisma.globalParameter.update).not.toHaveBeenCalled();
  });
});
