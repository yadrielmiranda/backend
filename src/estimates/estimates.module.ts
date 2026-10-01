import { PromotionsModule } from '@/promotions/promotions.module';
import { PaymentsModule } from '@/payments/payments.module';
import { Module } from '@nestjs/common';
import { MaterialRevisionsModule } from './material-revisions/material-revisions.module';
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
import { InstallationModule } from '@/installation/installation.module';
import { EstimateCustomerChargesService } from './estimate-customer-charges.service';
import { ContractsModule } from '@/contracts/contracts.module';
import { EstimateShareEmailController } from './public-share/estimate-share-email.controller';
import { EstimateShareEmailService } from './public-share/estimate-share-email.service';

@Module({
  imports: [PromotionsModule,
    PrismaModule,
    PricingRulesModule,
    LogsModule,
    FrameColorModule,
    NotificationsModule,
    InstallationModule,
    MaterialRevisionsModule,
    PaymentsModule,
    ContractsModule,
  ],
  controllers: [EstimatesController, PublicEstimatesController, EstimateShareEmailController],
  providers: [
    EstimatesService,
    EstimatePdfService,
    EstimateDimensionValidationService,
    EstimatePieceCalculatorService,
    EstimateMuntinService,
    EstimatePublicShareService,
    EstimateCustomerChargesService,
    EstimateShareEmailService,
  ],
})
export class EstimatesModule {}
