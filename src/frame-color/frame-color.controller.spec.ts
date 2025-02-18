import { Test, TestingModule } from '@nestjs/testing';
import { FrameColorController } from './frame-color.controller';
import { FrameColorService } from './frame-color.service';

describe('FrameColorController', () => {
  let controller: FrameColorController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FrameColorController],
      providers: [FrameColorService],
    }).compile();

    controller = module.get<FrameColorController>(FrameColorController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
