import { HttpModule } from '@nestjs/axios';
import { GoogleAddressValidationService } from '@/deliveries/google-address-validation.service';
import { GoogleRoutesService } from '@/deliveries/google-routes.service';
import { InstallationCoverageCalculationService } from './installation-coverage-calculation.service';
import { Module } from '@nestjs/common';
import { PromotionsModule } from '@/promotions/promotions.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { LogsModule } from '@/logs/logs.module';
import { InstallationCatalogController } from './installation-catalog.controller';
import { InstallationWorkflowController } from './installation-workflow.controller';
import { InstallationCatalogService } from './installation-catalog.service';
import { InstallationPricingService } from './installation-pricing.service';
import { InstallationWorkflowService } from './installation-workflow.service';
import { EstimateDimensionValidationService } from '@/estimates/dimensions/estimate-dimension-validation.service';
import { EstimateMuntinService } from '@/estimates/muntins/estimate-muntin.service';
import { EstimatePieceCalculatorService } from '@/estimates/calculation/estimate-piece-calculator.service';
import { NotificationsModule } from '@/notifications/notifications.module';
import { InstallationCoverageController } from './installation-coverage.controller';
import { InstallationCoverageService } from './installation-coverage.service';

@Module({
  imports: [HttpModule, PrismaModule, LogsModule, NotificationsModule, PromotionsModule],
  controllers: [InstallationCatalogController, InstallationWorkflowController, InstallationCoverageController],
  providers: [
    GoogleAddressValidationService,
    GoogleRoutesService,
    InstallationCoverageCalculationService,
    InstallationCoverageService,
    InstallationCatalogService,
    InstallationPricingService,
    InstallationWorkflowService,
    EstimateDimensionValidationService,
    EstimateMuntinService,
    EstimatePieceCalculatorService,
  ],
  exports: [InstallationPricingService, InstallationWorkflowService],
})
export class InstallationModule {}
