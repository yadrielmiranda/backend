import { Module } from '@nestjs/common';
import { DimensionPoliciesService } from './dimension-policies.service';
import { DimensionPoliciesController } from './dimension-policies.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { LogsModule } from 'src/logs/logs.module';

@Module({
  imports: [PrismaModule, LogsModule],
  controllers: [DimensionPoliciesController],
  providers: [DimensionPoliciesService],
  exports: [DimensionPoliciesService],
})
export class DimensionPoliciesModule {}
