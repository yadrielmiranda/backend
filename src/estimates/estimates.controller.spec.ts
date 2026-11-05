import { Test, TestingModule } from '@nestjs/testing';
import { EstimatesController } from './estimates.controller';
import { EstimatesService } from './estimates.service';
import { EstimatePublicShareService } from './public-share/estimate-public-share.service';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import { EstimateCustomerChargesService } from './estimate-customer-charges.service';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { AuthUser } from '@/auth/types/auth-user.type';
import type { Request } from 'express';

describe('EstimatesController', () => {
  let controller: EstimatesController;
  let estimates: { deleteEstimate: jest.Mock };

  beforeEach(async () => {
    estimates = { deleteEstimate: jest.fn().mockResolvedValue({ id: 17, idUser: 7 }) };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EstimatesController],
      providers: [
        { provide: EstimatesService, useValue: estimates },
        { provide: EstimatePublicShareService, useValue: {} },
        { provide: InstallationWorkflowService, useValue: {} },
        { provide: EstimateCustomerChargesService, useValue: {} },
      ],
    }).compile();

    controller = module.get<EstimatesController>(EstimatesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('keeps estimate endpoints protected by the authentication guard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, EstimatesController)).toContain(JwtAuthGuard);
  });

  it.each(['admin', 'dealer'] as const)('passes the authenticated %s actor through to the service', async name => {
    const actor: AuthUser = { id: name === 'admin' ? 99 : 7, role: { name } };
    const request = { user: actor } as Request;
    await expect(controller.remove(17, request)).resolves.toEqual({ id: 17, idUser: 7 });
    expect(estimates.deleteEstimate).toHaveBeenCalledTimes(1);
    expect(estimates.deleteEstimate).toHaveBeenCalledWith({ id: 17 }, actor);
    expect(estimates.deleteEstimate.mock.calls[0][1]).toBe(actor);
  });

  it('ignores an administrator role and owner identity supplied in the request body', async () => {
    const actor: AuthUser = { id: 8, role: { name: 'dealer' } };
    const request = {
      user: actor,
      body: {
        id: 7, idUser: 7, userId: 7, role: { name: 'admin' },
        user: { id: 99, role: { name: 'admin' } },
      },
    } as Request;
    await controller.remove(17, request);
    expect(estimates.deleteEstimate).toHaveBeenCalledWith({ id: 17 }, actor);
    expect(estimates.deleteEstimate.mock.calls[0][1]).toBe(actor);
  });
});
