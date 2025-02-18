import { Module } from '@nestjs/common';
import { TintsService } from './tints.service';
import { TintsController } from './tints.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TintsController],
  providers: [TintsService],
})
export class TintsModule { }
