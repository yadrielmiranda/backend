import { Test, TestingModule } from '@nestjs/testing';
import { CrystalController } from './crystals.controller';
import { CrystalService } from './crystals.service';

describe('CrystalsController', () => {
  let controller: CrystalController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CrystalController],
      providers: [CrystalService],
    }).compile();

    controller = module.get<CrystalController>(CrystalController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
