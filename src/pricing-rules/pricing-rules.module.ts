import { Module } from '@nestjs/common';
import { PricingRulesService } from './pricing-rules.service';
import { PricingRulesController } from './pricing-rules.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PricingRulesController],
  providers: [PricingRulesService],
  exports: [PricingRulesService], // Lo exportamos para poder usarlo en EstimatesService
})
export class PricingRulesModule {}