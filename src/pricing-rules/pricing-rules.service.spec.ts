import { Test, TestingModule } from '@nestjs/testing';
import { PricingRulesService } from './pricing-rules.service';

describe('PricingRulesService', () => {
  let service: PricingRulesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PricingRulesService],
    }).compile();

    service = module.get<PricingRulesService>(PricingRulesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
