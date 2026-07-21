import { Module } from '@nestjs/common';

import { PrismaModule } from '@/prisma/prisma.module';
import { LogsModule } from '@/logs/logs.module';

import { PricingRangesController } from './pricing-ranges.controller';
import { PricingRangesService } from './pricing-ranges.service';

@Module({
    imports: [PrismaModule, LogsModule],
    controllers: [PricingRangesController],
    providers: [PricingRangesService],
    exports: [PricingRangesService],
})
export class PricingRangesModule { }