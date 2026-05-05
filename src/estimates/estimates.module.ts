import { Module } from '@nestjs/common';
import { EstimatesService } from './estimates.service';
import { EstimatesController } from './estimates.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { PricingRulesModule } from '@/pricing-rules/pricing-rules.module';
import { LogsModule } from '@/logs/logs.module';
import { FrameColorModule } from '@/frame-color/frame-color.module';

@Module({
  imports: [PrismaModule, PricingRulesModule, LogsModule, FrameColorModule ],
  controllers: [EstimatesController],
  providers: [EstimatesService],
})
export class EstimatesModule {}
