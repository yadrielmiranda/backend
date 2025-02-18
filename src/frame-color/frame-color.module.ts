import { Module } from '@nestjs/common';
import { FrameColorService } from './frame-color.service';
import { FrameColorController } from './frame-color.controller';

@Module({
  controllers: [FrameColorController],
  providers: [FrameColorService],
})
export class FrameColorModule {}
