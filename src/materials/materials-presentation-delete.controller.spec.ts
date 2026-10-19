import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { validate } from 'class-validator';
import { randomUUID } from 'crypto';
import { ROLES_KEY } from '@/auth/roles.decorator';
import { MaterialsController } from './materials.controller';
import { MaterialPresentationDeleteDto } from './materials.dto';

describe('Material presentation deletion endpoint', () => {
  it('exposes an admin-only DELETE without widening staff permissions', () => {
    const method = MaterialsController.prototype.deletePresentation;
    expect(Reflect.getMetadata(PATH_METADATA, MaterialsController)).toBe('materials');
    expect(Reflect.getMetadata(ROLES_KEY, MaterialsController)).toEqual(['admin', 'operator']);
    expect(Reflect.getMetadata(PATH_METADATA, method)).toBe('presentations/:id');
    expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(RequestMethod.DELETE);
    expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual(['admin']);
  });

  it('forwards the selected presentation, version, retry key and authenticated actor', async () => {
    const service = { deletePresentation: jest.fn().mockResolvedValue({ id: 12, productId: 3, replayed: false }) };
    const controller = new MaterialsController(service as any);
    const user = { id: 1, role: { name: 'admin' } };
    const dto = { requestKey: randomUUID(), version: 0 };
    await controller.deletePresentation(12, dto, { user } as any);
    expect(service.deletePresentation).toHaveBeenCalledWith(12, dto, user);
  });

  it.each([
    {}, { requestKey: randomUUID() }, { requestKey: 'invalid', version: 0 },
    { requestKey: randomUUID(), version: -1 }, { requestKey: randomUUID(), version: 0.5 },
    { requestKey: randomUUID(), version: '0' },
  ])('rejects invalid delete data: %j', async input => {
    expect((await validate(Object.assign(new MaterialPresentationDeleteDto(), input))).length).toBeGreaterThan(0);
  });

  it('accepts a new UUID and the current integer version', async () => {
    expect(await validate(Object.assign(new MaterialPresentationDeleteDto(), { requestKey: randomUUID(), version: 0 }))).toEqual([]);
  });
});
