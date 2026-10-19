import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { EnergyRatingsController } from './energy-ratings.controller';
import { EnergyRatingsService } from './energy-ratings.service';

@Module({
  imports: [PrismaModule],
  controllers: [EnergyRatingsController],
  providers: [EnergyRatingsService],
  exports: [EnergyRatingsService],
})
export class EnergyRatingsModule {}
