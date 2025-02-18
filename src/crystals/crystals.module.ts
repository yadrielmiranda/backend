import { Module } from '@nestjs/common';
import { CrystalsService } from './crystals.service';
import { CrystalsController } from './crystals.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [CrystalsController],
  providers: [CrystalsService],
})
export class CrystalsModule { }
