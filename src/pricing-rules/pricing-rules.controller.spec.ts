import { Test, TestingModule } from '@nestjs/testing';
import { PricingRulesController } from './pricing-rules.controller';
import { PricingRulesService } from './pricing-rules.service';

describe('PricingRulesController', () => {
  let controller: PricingRulesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PricingRulesController],
      providers: [PricingRulesService],
    }).compile();

    controller = module.get<PricingRulesController>(PricingRulesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
