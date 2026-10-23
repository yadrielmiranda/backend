import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ROLES_KEY } from '@/auth/roles.decorator';
import { MaterialsTechnicianController } from './materials-technician.controller';
import { TechnicianMaterialStoreIssueDto } from './materials-store-issue.dto';

describe('Technician material portal endpoints', () => {
  it('exposes only technician inventory, internal use and own history', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MaterialsTechnicianController)).toBe('technician/materials');
    expect(Reflect.getMetadata(ROLES_KEY, MaterialsTechnicianController)).toEqual(['technician']);
    for (const [method, path, requestMethod] of [
      ['getInventory', 'stores/:storeId/inventory', RequestMethod.GET],
      ['internalUse', 'stores/:storeId/internal-use', RequestMethod.POST],
      ['history', 'history', RequestMethod.GET],
    ] as const) {
      expect(Reflect.getMetadata(PATH_METADATA, MaterialsTechnicianController.prototype[method])).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, MaterialsTechnicianController.prototype[method])).toBe(requestMethod);
    }
  });

  it('uses the authenticated actor for all portal endpoints', async () => {
    const inventory = { getTechnicianInventory: jest.fn() };
    const issue = { technicianInternalUse: jest.fn(), technicianHistory: jest.fn() };
    const controller = new MaterialsTechnicianController(inventory as any, issue as any);
    const user = { id: 12, role: { name: 'technician' } };
    const dto = { requestKey: 'key', lines: [] };
    await controller.getInventory(3, { user } as any);
    await controller.internalUse(3, dto, { user } as any);
    await controller.history({ page: '2' }, { user } as any);
    expect(inventory.getTechnicianInventory).toHaveBeenCalledWith(3, user);
    expect(issue.technicianInternalUse).toHaveBeenCalledWith(3, dto, user);
    expect(issue.technicianHistory).toHaveBeenCalledWith({ page: '2' }, user);
  });

  it('strips spoofed actor, recipient and reason metadata from technician request bodies', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false, transformOptions: { enableImplicitConversion: true } });
    const result = await pipe.transform({
      requestKey: '8a99dc20-45a2-42d9-9e5b-05b9b3134623', lines: [{ productId: 1, presentationId: 11, quantity: 1, actorId: 8 }],
      actorId: 7, recipient: 'Another technician', note: 'Sale',
    }, { type: 'body', metatype: TechnicianMaterialStoreIssueDto });
    expect(result).toEqual({ requestKey: '8a99dc20-45a2-42d9-9e5b-05b9b3134623', lines: [{ productId: 1, presentationId: 11, quantity: 1 }] });
  });
});
