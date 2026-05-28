import { Module } from '@nestjs/common';
import { EstimatesService } from './estimates.service';
import { EstimatesController } from './estimates.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { PricingRulesModule } from '@/pricing-rules/pricing-rules.module';
import { LogsModule } from '@/logs/logs.module';
import { FrameColorModule } from '@/frame-color/frame-color.module';
import { EstimatePdfService } from './pdf/estimate-pdf.service';
import { EstimateDimensionValidationService } from './dimensions/estimate-dimension-validation.service';
import { EstimatePieceCalculatorService } from './calculation/estimate-piece-calculator.service';
import { EstimateMuntinService } from './muntins/estimate-muntin.service';
import { EstimatePublicShareService } from './public-share/estimate-public-share.service';
import { PublicEstimatesController } from './public-share/public-estimates.controller';
import { NotificationsModule } from '@/notifications/notifications.module';

@Module({
  imports: [
  PrismaModule,
  PricingRulesModule,
  LogsModule,
  FrameColorModule,
  NotificationsModule,
],
  controllers: [EstimatesController, PublicEstimatesController],
  providers: [
    EstimatesService,
    EstimatePdfService,
    EstimateDimensionValidationService,
    EstimatePieceCalculatorService,
    EstimateMuntinService,
    EstimatePublicShareService,
  ],
})
export class EstimatesModule { }
