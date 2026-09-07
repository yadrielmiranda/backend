import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { PromotionsService } from './promotions.service';
import { PromotionsController } from './promotions.controller';
@Module({
  imports: [PrismaModule],
  providers: [PromotionsService],
  controllers: [PromotionsController],
  exports: [PromotionsService],
})
export class PromotionsModule {}
