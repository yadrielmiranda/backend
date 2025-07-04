import { Module } from '@nestjs/common';
import { TintService } from './tints.service';
import { TintController } from './tints.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TintController],
  providers: [TintService],
})
export class TintsModule { }
