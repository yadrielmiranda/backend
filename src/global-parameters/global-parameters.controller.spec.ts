import { Test, TestingModule } from '@nestjs/testing';
import { GlobalParametersController } from './global-parameters.controller';
import { GlobalParametersService } from './global-parameters.service';

describe('GlobalParametersController', () => {
  let controller: GlobalParametersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GlobalParametersController],
      providers: [GlobalParametersService],
    }).compile();

    controller = module.get<GlobalParametersController>(GlobalParametersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
