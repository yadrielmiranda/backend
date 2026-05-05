import { Module } from '@nestjs/common';
import { FrameColorService } from './frame-color.service';
import { FrameColorController } from './frame-color.controller';
import { PrismaModule } from '@/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [FrameColorController],
  providers: [FrameColorService],
  exports: [FrameColorService],
})
export class FrameColorModule { }
