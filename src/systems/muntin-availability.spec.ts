import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateSystemConfigDto } from './dto/update-system-config.dto';
import { SystemsService } from './systems.service';

function fixture(mode = 'ALL', selected: number[] = []) {
  const current = { muntinAvailability: mode, allowedMuntinTypes: selected.map(muntinTypeId => ({ muntinTypeId })) };
  const tx = {
    $queryRaw: jest.fn(async () => []),
    sysConf: {
      findUnique: jest.fn(async () => current),
      update: jest.fn(async () => ({})),
    },
    muntinType: { findMany: jest.fn(async ({ where }) => where.id.in.map(id => ({ id }))) },
  };
  const db = {
    sysConf: { findUnique: jest.fn(async () => ({
      isSelectableInEstimate: true,
      system: { defaultConfigId: null, brandProduct: { product: { kind: 'GLAZED_UNIT' } } },
    })) },
    $transaction: jest.fn(async work => work(tx)),
    system: { findUnique: jest.fn(async () => ({ id: 10, sysconfs: [current] })) },
  };
  const service = new SystemsService(db as any);
  return { service, tx, db };
}

describe('series/configuration muntin settings', () => {
  it('saves SELECTED mode and active types together for the addressed combination', async () => {
    const { service, tx } = fixture();
    await service.updateSystemConfig(10, 20, { muntinAvailability: 'SELECTED', allowedMuntinTypeIds: [7, 2] });
    expect(tx.muntinType.findMany).toHaveBeenCalledWith({ where: { id: { in: [2, 7] }, isActive: true }, select: { id: true } });
    expect(tx.sysConf.update).toHaveBeenCalledWith({
      where: { idSystem_idConfig: { idSystem: 10, idConfig: 20 } },
      data: {
        muntinAvailability: 'SELECTED',
        allowedMuntinTypes: { deleteMany: {}, create: [{ muntinType: { connect: { id: 2 } } }, { muntinType: { connect: { id: 7 } } }] },
      },
    });
  });

  it('rejects nonexistent or inactive types before writing settings', async () => {
    const { service, tx } = fixture();
    tx.muntinType.findMany.mockResolvedValue([{ id: 2 }]);
    await expect(service.updateSystemConfig(10, 20, { muntinAvailability: 'SELECTED', allowedMuntinTypeIds: [2, 7] }))
      .rejects.toThrow('invalid or inactive');
    expect(tx.sysConf.update).not.toHaveBeenCalled();
  });

  it.each([[], [7, 7], [0], [-1], [1.5]].map(ids => ({ ids })))('rejects invalid selections $ids without writing', async ({ ids }) => {
    const { service, tx } = fixture();
    await expect(service.updateSystemConfig(10, 20, { muntinAvailability: 'SELECTED', allowedMuntinTypeIds: ids }))
      .rejects.toThrow();
    expect(tx.sysConf.update).not.toHaveBeenCalled();
  });

  it.each(['NONE', 'ALL'] as const)('clears selected restrictions when switching to %s', async mode => {
    const { service, tx } = fixture('SELECTED', [7]);
    await service.updateSystemConfig(10, 20, { muntinAvailability: mode });
    expect(tx.sysConf.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { muntinAvailability: mode, allowedMuntinTypes: { deleteMany: {}, create: [] } },
    }));
  });

  it('preserves policy when an older caller updates only screen', async () => {
    const { service, tx } = fixture('SELECTED', [7]);
    await service.updateSystemConfig(10, 20, { allowScreen: true });
    expect(tx.sysConf.update).toHaveBeenCalledWith(expect.objectContaining({ data: { allowScreen: true } }));
    expect(tx.muntinType.findMany).not.toHaveBeenCalled();
  });

  it('returns the stable flat contract without exposing relational join records', async () => {
    const { service } = fixture('SELECTED', [7, 2]);
    const result: any = await service.getSystemWithConfigs(10);
    expect(result.sysconfs[0]).toEqual({ muntinAvailability: 'SELECTED', allowedMuntinTypeIds: [2, 7] });
  });

  it.each([
    { muntinAvailability: 'UNKNOWN' }, { muntinAvailability: null },
    { allowedMuntinTypeIds: null }, { allowedMuntinTypeIds: [7, 7] },
    { allowedMuntinTypeIds: [0] }, { allowedMuntinTypeIds: [1.5] },
  ])('validates malformed API settings %j', async input => {
    const errors = await validate(plainToInstance(UpdateSystemConfigDto, input));
    expect(errors.length).toBeGreaterThan(0);
  });
});
