import type { Request } from 'express';
import { GlobalParametersController } from './global-parameters.controller';

describe('GlobalParametersController', () => {
  let controller: GlobalParametersController;
  let service: any;

  beforeEach(() => {
    service = { findAll: jest.fn().mockResolvedValue([]) };
    controller = new GlobalParametersController(service);
  });

  it('allows admins to read the internal threshold', async () => {
    await controller.findAll({ user: { id: 1, role: { name: 'admin' } } } as unknown as Request);
    expect(service.findAll).toHaveBeenCalledWith(true);
  });

  it.each(['client', 'dealer', 'operator', 'technician', undefined])(
    'keeps the threshold private for %s', async (role) => {
      await controller.findAll({ user: { id: 2, role: role ? { name: role } : undefined } } as unknown as Request);
      expect(service.findAll).toHaveBeenCalledWith(false);
    },
  );
});
