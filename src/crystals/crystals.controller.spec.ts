import { Test, TestingModule } from '@nestjs/testing';
import { CrystalsController } from './crystals.controller';
import { CrystalsService } from './crystals.service';

describe('CrystalsController', () => {
  let controller: CrystalsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CrystalsController],
      providers: [CrystalsService],
    }).compile();

    controller = module.get<CrystalsController>(CrystalsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
