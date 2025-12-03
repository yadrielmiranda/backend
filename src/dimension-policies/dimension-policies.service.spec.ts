import { Test, TestingModule } from '@nestjs/testing';
import { DimensionPoliciesService } from './dimension-policies.service';

describe('DimensionPoliciesService', () => {
  let service: DimensionPoliciesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DimensionPoliciesService],
    }).compile();

    service = module.get<DimensionPoliciesService>(DimensionPoliciesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
