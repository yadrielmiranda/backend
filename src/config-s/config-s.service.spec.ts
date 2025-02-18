import { Test, TestingModule } from '@nestjs/testing';
import { ConfigSService } from './config-s.service';

describe('ConfigSService', () => {
  let service: ConfigSService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ConfigSService],
    }).compile();

    service = module.get<ConfigSService>(ConfigSService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
