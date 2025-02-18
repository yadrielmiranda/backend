import { Module } from '@nestjs/common';
import { FrameColorService } from './frame-color.service';
import { FrameColorController } from './frame-color.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [FrameColorController],
  providers: [FrameColorService],
})
export class FrameColorModule { }
