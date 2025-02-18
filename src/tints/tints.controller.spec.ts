import { Test, TestingModule } from '@nestjs/testing';
import { TintsController } from './tints.controller';
import { TintsService } from './tints.service';

describe('TintsController', () => {
  let controller: TintsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TintsController],
      providers: [TintsService],
    }).compile();

    controller = module.get<TintsController>(TintsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
