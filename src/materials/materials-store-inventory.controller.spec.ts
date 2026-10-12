import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ROLES_KEY } from '@/auth/roles.decorator';
import { MaterialsStoreInventoryController } from './materials-store-inventory.controller';

describe('MaterialsStoreInventoryController', () => {
  it('exposes staff read and admin-only count endpoints', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MaterialsStoreInventoryController)).toBe('materials/stores');
    expect(Reflect.getMetadata(ROLES_KEY, MaterialsStoreInventoryController)).toEqual(['admin', 'operator']);
    const get = MaterialsStoreInventoryController.prototype.getInventory;
    const count = MaterialsStoreInventoryController.prototype.count;
    expect(Reflect.getMetadata(PATH_METADATA, get)).toBe(':storeId/inventory');
    expect(Reflect.getMetadata(METHOD_METADATA, get)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, count)).toBe(':storeId/count');
    expect(Reflect.getMetadata(METHOD_METADATA, count)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(ROLES_KEY, count)).toEqual(['admin']);
  });

  it('forwards the authenticated actor and selected store', async () => {
    const service = { getInventory: jest.fn().mockResolvedValue({ products: [] }), count: jest.fn().mockResolvedValue({ countedProducts: 1 }) };
    const controller = new MaterialsStoreInventoryController(service as any);
    const user = { id: 2, role: { name: 'admin' } };
    const dto = { requestKey: 'key', products: [], note: 'Count' };
    await controller.getInventory(7, { user } as any);
    await controller.count(7, dto, { user } as any);
    expect(service.getInventory).toHaveBeenCalledWith(7, user);
    expect(service.count).toHaveBeenCalledWith(7, dto, user);
  });
});
