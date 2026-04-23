import { Module } from '@nestjs/common';
import { EstimatesService } from './estimates.service';
import { EstimatesController } from './estimates.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { PricingRulesModule } from '@/pricing-rules/pricing-rules.module';
import { LogsModule } from '@/logs/logs.module';

@Module({
  imports: [PrismaModule, PricingRulesModule, LogsModule],
  controllers: [EstimatesController],
  providers: [EstimatesService],
})
export class EstimatesModule {}
