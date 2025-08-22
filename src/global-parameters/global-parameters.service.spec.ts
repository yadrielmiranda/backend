import { Test, TestingModule } from '@nestjs/testing';
import { GlobalParametersService } from './global-parameters.service';

describe('GlobalParametersService', () => {
  let service: GlobalParametersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GlobalParametersService],
    }).compile();

    service = module.get<GlobalParametersService>(GlobalParametersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
