import { Test, TestingModule } from '@nestjs/testing';
import { CoatingController } from './coating.controller';
import { CoatingService } from './coating.service';

describe('CoatingController', () => {
  let controller: CoatingController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CoatingController],
      providers: [CoatingService],
    }).compile();

    controller = module.get<CoatingController>(CoatingController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
