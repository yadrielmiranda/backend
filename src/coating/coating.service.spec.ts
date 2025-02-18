import { Test, TestingModule } from '@nestjs/testing';
import { CoatingService } from './coating.service';

describe('CoatingService', () => {
  let service: CoatingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CoatingService],
    }).compile();

    service = module.get<CoatingService>(CoatingService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
