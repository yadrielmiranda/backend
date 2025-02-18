import { Test, TestingModule } from '@nestjs/testing';
import { ConfigSController } from './config-s.controller';
import { ConfigSService } from './config-s.service';

describe('ConfigSController', () => {
  let controller: ConfigSController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ConfigSController],
      providers: [ConfigSService],
    }).compile();

    controller = module.get<ConfigSController>(ConfigSController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
