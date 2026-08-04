import { Module } from '@nestjs/common';
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

@Module({
  imports: [PrismaModule, LogsModule],
  controllers: [
    InstallationCatalogController,
    InstallationWorkflowController,
  ],
  providers: [
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
