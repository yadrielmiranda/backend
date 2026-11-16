import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { SystemsController } from './systems.controller';
import { SystemsService } from './systems.service';
import { SystemInstallationApprovalService } from './system-installation-approval.service';
import { HEADERS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '@/auth/roles.decorator';
import { IS_PUBLIC_KEY } from '@/auth/public.decorator';

describe('SystemsController', () => {
  let controller: SystemsController;
  const approvals = { find: jest.fn(), findBatch: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SystemsController],
      providers: [
        { provide: SystemsService, useValue: {} },
        { provide: SystemInstallationApprovalService, useValue: approvals },
      ],
    }).compile();

    controller = module.get<SystemsController>(SystemsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns the lookup result without changing the system or exposing catalog data', async () => {
    approvals.find.mockResolvedValueOnce({ status: 'not_found' });
    await expect(controller.getInstallationApproval(36)).resolves.toEqual({ status: 'not_found' });
    expect(approvals.find).toHaveBeenCalledWith(36);
  });

  it('keeps the new endpoint authenticated, explicitly permits read roles, and disables response caching', () => {
    const method = SystemsController.prototype.getInstallationApproval;
    expect(Reflect.getMetadata(PATH_METADATA, method)).toBe(':id/installation-approval');
    expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual(['admin', 'operator', 'dealer', 'client', 'technician']);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, method)).not.toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, SystemsController)).not.toBe(true);
    expect(Reflect.getMetadata(HEADERS_METADATA, method)).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
  });

  it('delegates the complete batch query without accepting caller-provided system identities', async () => {
    const result = { systems: [{ systemId: 36, systemName: 'Serie 700', status: 'not_found' }] };
    approvals.findBatch.mockResolvedValueOnce(result);
    await expect(controller.getProductApprovals('36,22,36')).resolves.toBe(result);
    expect(approvals.findBatch).toHaveBeenCalledWith('36,22,36');
  });

  it('registers the authenticated uncached batch route before the generic ID route', () => {
    const method = SystemsController.prototype.getProductApprovals;
    expect(Reflect.getMetadata(PATH_METADATA, method)).toBe('approvals');
    expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual(['admin', 'operator', 'dealer', 'client', 'technician']);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, method)).not.toBe(true);
    expect(Reflect.getMetadata(HEADERS_METADATA, method)).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
    const methods = Object.getOwnPropertyNames(SystemsController.prototype);
    expect(methods.indexOf('getProductApprovals')).toBeLessThan(methods.indexOf('getSystem'));
  });

  it('preserves malformed structured query values for strict validation instead of coercing arrays into CSV', async () => {
    const [metatype] = Reflect.getMetadata('design:paramtypes', SystemsController.prototype, 'getProductApprovals');
    const pipe = new ValidationPipe({ transform: true, transformOptions: { enableImplicitConversion: true } });
    for (const value of [['36', '22'], { id: '36' }]) {
      await expect(pipe.transform(value, { type: 'query', metatype, data: 'ids' })).resolves.toBe(value);
    }
  });
});
