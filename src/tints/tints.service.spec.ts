import { Test, TestingModule } from '@nestjs/testing';
import { TintsService } from './tints.service';

describe('TintsService', () => {
  let service: TintsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TintsService],
    }).compile();

    service = module.get<TintsService>(TintsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
