import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { InstallationModule } from '@/installation/installation.module';
import { PromotionsModule } from '@/promotions/promotions.module';
import { NotificationsModule } from '@/notifications/notifications.module';
import { EstimatePieceCalculatorService } from '@/estimates/calculation/estimate-piece-calculator.service';
import { EstimateMuntinService } from '@/estimates/muntins/estimate-muntin.service';
import { EstimateDimensionValidationService } from '@/estimates/dimensions/estimate-dimension-validation.service';
import { MaterialRevisionsController } from './material-revisions.controller';
import { MaterialRevisionsService } from './material-revisions.service';

@Module({
  imports: [PrismaModule, InstallationModule, PromotionsModule, NotificationsModule],
  controllers: [MaterialRevisionsController],
  providers: [MaterialRevisionsService, EstimatePieceCalculatorService, EstimateMuntinService, EstimateDimensionValidationService],
  exports: [MaterialRevisionsService],
})
export class MaterialRevisionsModule {}
