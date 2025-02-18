import { Test, TestingModule } from '@nestjs/testing';
import { FrameColorService } from './frame-color.service';

describe('FrameColorService', () => {
  let service: FrameColorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FrameColorService],
    }).compile();

    service = module.get<FrameColorService>(FrameColorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
