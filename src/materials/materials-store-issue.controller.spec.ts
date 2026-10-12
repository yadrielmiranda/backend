import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ROLES_KEY } from '@/auth/roles.decorator';
import { MaterialsStoreIssueController } from './materials-store-issue.controller';

describe('MaterialsStoreIssueController', () => {
  it('exposes a staff-only store internal-use endpoint', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MaterialsStoreIssueController)).toBe('materials/stores');
    expect(Reflect.getMetadata(ROLES_KEY, MaterialsStoreIssueController)).toEqual(['admin', 'operator']);
    const issue = MaterialsStoreIssueController.prototype.internalUse;
    expect(Reflect.getMetadata(PATH_METADATA, issue)).toBe(':storeId/internal-use');
    expect(Reflect.getMetadata(METHOD_METADATA, issue)).toBe(RequestMethod.POST);
  });

  it('forwards the selected store and authenticated actor', async () => {
    const service = { internalUse: jest.fn().mockResolvedValue({ productCount: 2 }) };
    const controller = new MaterialsStoreIssueController(service as any);
    const user = { id: 2, role: { name: 'operator' } };
    const dto = { requestKey: 'key', lines: [], recipient: 'Technician', note: 'Installation' };
    await controller.internalUse(7, dto, { user } as any);
    expect(service.internalUse).toHaveBeenCalledWith(7, dto, user);
  });
});
