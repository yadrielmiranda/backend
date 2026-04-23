import { Module } from '@nestjs/common';
import { DimensionPoliciesService } from './dimension-policies.service';
import { DimensionPoliciesController } from './dimension-policies.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { LogsModule } from '@/logs/logs.module';

@Module({
  imports: [PrismaModule, LogsModule],
  controllers: [DimensionPoliciesController],
  providers: [DimensionPoliciesService],
  exports: [DimensionPoliciesService],
})
export class DimensionPoliciesModule {}
