import { Module } from '@nestjs/common';
import { DimensionPoliciesService } from './dimension-policies.service';
import { DimensionPoliciesController } from './dimension-policies.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [DimensionPoliciesController],
  providers: [DimensionPoliciesService],
  exports: [DimensionPoliciesService]
})
export class DimensionPoliciesModule {}
