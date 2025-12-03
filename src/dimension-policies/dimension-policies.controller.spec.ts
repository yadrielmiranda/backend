import { Test, TestingModule } from '@nestjs/testing';
import { DimensionPoliciesController } from './dimension-policies.controller';
import { DimensionPoliciesService } from './dimension-policies.service';

describe('DimensionPoliciesController', () => {
  let controller: DimensionPoliciesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DimensionPoliciesController],
      providers: [DimensionPoliciesService],
    }).compile();

    controller = module.get<DimensionPoliciesController>(DimensionPoliciesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
