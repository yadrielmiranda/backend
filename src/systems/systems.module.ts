import { Module } from '@nestjs/common';
import { SystemsService } from './systems.service';
import { SystemsController } from './systems.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { SystemMuntinsController } from './system-muntins.controller';
import { SystemMuntinsService } from './system-muntins.service';
import { SystemDesignsController } from './system-designs.controller';
import { SystemDesignsService } from './system-designs.service';
import { HttpModule } from '@nestjs/axios';
import { SystemInstallationApprovalService } from './system-installation-approval.service';

@Module({
  imports:[PrismaModule, HttpModule],
  controllers: [SystemsController, SystemMuntinsController, SystemDesignsController],
  providers: [SystemsService, SystemMuntinsService, SystemDesignsService, SystemInstallationApprovalService],
})
export class SystemsModule {}
