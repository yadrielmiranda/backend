import { SystemsService } from './systems.service';

describe('retired SysConf muntin controls', () => {
  it.each([{ muntinAvailability: 'ALL' }, { muntinAvailability: 'NONE' }, { allowedMuntinTypeIds: [7] }])
  ('rejects obsolete settings before any database operation: %j', async input => {
    const service = new SystemsService({} as any);
    await expect(service.updateSystemConfig(10, 20, input as any)).rejects.toThrow('Manage Muntins');
  });

  it('keeps screen-only updates independent and returns exact catalog rules', async () => {
    const tx = { sysConf: { update: jest.fn() } };
    const db = {
      sysConf: { findUnique: jest.fn(async () => ({ isSelectableInEstimate: true,
        system: { defaultConfigId: null, brandProduct: { product: { kind: 'GLAZED_UNIT' } } } })) },
      $transaction: jest.fn(async work => work(tx)),
      system: { findUnique: jest.fn(async () => ({ id: 10, sysconfs: [{
        muntinAssignments: [{ ruleId: 1, idCrystal: 3, patternId: 2, rule: {
          availability: 'SELECTED', allowedTypes: [{ muntinTypeId: 7 }, { muntinTypeId: 2 }],
        } }],
      }] })) },
    };
    const service = new SystemsService(db as any);
    const result: any = await service.updateSystemConfig(10, 20, { allowScreen: true });
    expect(tx.sysConf.update).toHaveBeenCalledWith({
      where: { idSystem_idConfig: { idSystem: 10, idConfig: 20 } }, data: { allowScreen: true },
    });
    expect(result.sysconfs[0]).toEqual({ muntinRules: [{
      ruleId: 1, crystalId: 3, patternId: 2, availability: 'SELECTED', allowedTypeIds: [2, 7],
    }] });
  });

  it('reorders retained crystal associations without deleting their muntin assignments', async () => {
    const tx = {
      $queryRaw: jest.fn(async () => [{ id: 10 }]),
      systemCrystal: { deleteMany: jest.fn(), upsert: jest.fn() }, system: { update: jest.fn() },
    };
    const db = {
      system: { findUnique: jest.fn(async () => ({ id: 10, brandProduct: { product: { kind: 'GLAZED_UNIT' } } })) },
      crystal: { findMany: jest.fn(async () => [{ id: 3 }, { id: 2 }]) },
      $transaction: jest.fn(async work => work(tx)),
    };
    const service = new SystemsService(db as any);
    jest.spyOn(service, 'getSystemCrystalsForManage').mockResolvedValue({} as any);
    await service.updateSystemCrystals(10, { crystalIds: [3, 2], defaultCrystalId: 3 });
    expect(tx.systemCrystal.deleteMany).toHaveBeenCalledWith({ where: { idSystem: 10, idCrystal: { notIn: [3, 2] } } });
    expect(tx.systemCrystal.upsert).toHaveBeenNthCalledWith(1, {
      where: { idSystem_idCrystal: { idSystem: 10, idCrystal: 3 } },
      create: { idSystem: 10, idCrystal: 3, sortOrder: 0 }, update: { sortOrder: 0 },
    });
    expect(tx.systemCrystal.upsert).toHaveBeenCalledTimes(2);
  });
});
