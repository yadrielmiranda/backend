import { Module } from '@nestjs/common';
import { CrystalsService } from './crystals.service';
import { CrystalsController } from './crystals.controller';

@Module({
  controllers: [CrystalsController],
  providers: [CrystalsService],
})
export class CrystalsModule {}
