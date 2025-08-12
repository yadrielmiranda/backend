import { Module } from '@nestjs/common';
import { EstimatesService } from './estimates.service';
import { EstimatesController } from './estimates.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PricingRulesModule } from 'src/pricing-rules/pricing-rules.module';

@Module({
  imports: [PrismaModule, PricingRulesModule],
  controllers: [EstimatesController],
  providers: [EstimatesService],
})
export class EstimatesModule { }
