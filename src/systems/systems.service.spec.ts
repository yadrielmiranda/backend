import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@/prisma/prisma.service';
import { SystemsService } from './systems.service';

describe('SystemsService', () => {
  let service: SystemsService;
  const findMany = jest.fn();
  const pricedDesigns = jest.fn();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SystemsService, { provide: PrismaService, useValue: {
        system: { findMany }, frenchDoorDesign: { findMany: pricedDesigns },
      } }],
    }).compile();

    service = module.get<SystemsService>(SystemsService);
  });

  it('lists only compatible French Door artwork for each estimate configuration', async () => {
    const design = { id: 9, code: '01', artworkKey: 'SD01', kind: 'SINGLE' };
    const sysconf = (conf: string) => ({
      config: { conf, idProduct: 5 }, dimensionMode: 'ECO_WINDOWS_DOOR', muntinAssignments: [],
    });
    const system = { allowDesign: true, brandProduct: { product: { id: 5, diagramFamily: 'FRENCH_DOOR', kind: 'GLAZED_UNIT' } },
      designOptions: [{ design: { name: 'Garage template' } }], sysconfs: [sysconf('OX'), sysconf('O'), sysconf('XX')] };
    findMany.mockResolvedValue([system, { ...system, allowDesign: false }, system]);
    pricedDesigns.mockResolvedValue([design]);

    const systems = await service.findAllWithConfigs();
    expect(systems[0]).toMatchObject({ doorDesigns: [design], designOptions: [], sysconfs: [
      { doorDesignKind: 'SINGLE' }, { doorDesignKind: null }, { doorDesignKind: 'DOUBLE' },
    ] });
    expect(systems[1]).toMatchObject({ doorDesigns: [], sysconfs: [
      { doorDesignKind: null }, { doorDesignKind: null }, { doorDesignKind: null },
    ] });
    expect(pricedDesigns).toHaveBeenCalledTimes(1);
    expect(pricedDesigns).toHaveBeenCalledWith({ where: { unitPrice: { not: null } },
      select: { id: true, code: true, artworkKey: true, kind: true }, orderBy: { code: 'asc' } });
  });
});
