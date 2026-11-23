import { sortStandardDoorDesigns } from './door-design-order';
import { DoorDesignsService } from './door-designs.service';
import { SystemsService } from '@/systems/systems.service';
import { DOOR_DESIGN_PICKER } from './door-design-policy';

const codes = (values: string[]) => values.map((code, index) => ({ id: index + 1, code }));

describe('French Door catalog order', () => {
  it('continues standard codes across 99/100 while preserving custom positions, identities and input', () => {
    const input = codes(['CUSTOM-10', 'AE-SD-100', 'AE-DD-109', 'AE-SD-99-CUSTOM', 'AE-SD-98', 'AE-DD-99', 'CUSTOM-2', 'AE-SD-99']);
    const before = [...input];
    const output = sortStandardDoorDesigns(input);
    expect(output.map(row => row.code)).toEqual([
      'CUSTOM-10', 'AE-SD-98', 'AE-DD-99', 'AE-SD-99-CUSTOM', 'AE-SD-99', 'AE-DD-109', 'CUSTOM-2', 'AE-SD-100',
    ]);
    expect(input).toEqual(before);
    expect(output[1]).toBe(input[4]);
    expect(output[3]).toBe(input[3]);
    expect(sortStandardDoorDesigns([])).toEqual([]);
  });

  it('orders every catalog boundary and preserves custom-only catalogs', () => {
    const input = codes(['AE-SD-110', 'AE-SD-109', 'AE-SD-01', 'AE-SD-100', 'AE-SD-99', 'AE-SD-97', 'AE-SD-96']);
    expect(sortStandardDoorDesigns(input).map(row => row.code)).toEqual([
      'AE-SD-01', 'AE-SD-96', 'AE-SD-97', 'AE-SD-99', 'AE-SD-100', 'AE-SD-109', 'AE-SD-110',
    ]);
    const custom = codes(['A-10', 'A-2', 'ae-sd-100', 'AE-SD-99-special']);
    expect(sortStandardDoorDesigns(custom)).toEqual(custom);
  });

  it('serves the same ordered identities in Settings without changing the query or prices', async () => {
    const rows = codes(['AE-SD-100', 'AE-SD-98', 'AE-SD-99']).map(row => ({ ...row, unitPrice: null }));
    const findMany = jest.fn().mockResolvedValue(rows);
    const result = await new DoorDesignsService({ frenchDoorDesign: { findMany } } as any).list();
    expect(result.map(row => row.code)).toEqual(['AE-SD-98', 'AE-SD-99', 'AE-SD-100']);
    expect(result.every(row => row.unitPrice === null)).toBe(true);
    expect(findMany).toHaveBeenCalledWith({ orderBy: [{ kind: 'asc' }, { code: 'asc' }] });
  });

  it('orders the estimate catalog and keeps the price and door eligibility filters', async () => {
    const rows = codes(['AE-SD-100', 'AE-SD-98', 'AE-SD-99']);
    const product = { id: 5, kind: 'GLAZED_UNIT', diagramFamily: 'FRENCH_DOOR' };
    const config = { config: { idProduct: 5, conf: 'X' }, dimensionMode: 'STANDARD', muntinAssignments: [],
      activeOptions: [], preparationOptions: [], sillOptions: [], reinforcementOptions: [],
      system: { allowDesign: true, brandProduct: { product } } };
    const findMany = jest.fn().mockResolvedValue(rows);
    const db = { frenchDoorDesign: { findMany }, sysConf: { findUnique: jest.fn().mockResolvedValue(config) },
      system: { findMany: jest.fn().mockResolvedValue([{ ...config.system, sysconfs: [config] }]) } };
    const service = new SystemsService(db as any);
    const result = await service.getSystemConfigOptions(1, 1);
    expect(result.doorDesigns.map(row => row.code)).toEqual(['AE-SD-98', 'AE-SD-99', 'AE-SD-100']);
    expect(findMany).toHaveBeenLastCalledWith({ ...DOOR_DESIGN_PICKER, where: { unitPrice: { not: null }, kind: 'SINGLE' } });
    const systems = await service.findAllWithConfigs();
    expect((systems[0] as any).doorDesigns.map(row => row.code)).toEqual(['AE-SD-98', 'AE-SD-99', 'AE-SD-100']);
    expect(findMany).toHaveBeenLastCalledWith(DOOR_DESIGN_PICKER);
  });
});
