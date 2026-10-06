import { Module } from '@nestjs/common';
import { SystemsService } from './systems.service';
import { SystemsController } from './systems.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { SystemMuntinsController } from './system-muntins.controller';
import { SystemMuntinsService } from './system-muntins.service';

@Module({
  imports:[PrismaModule],
  controllers: [SystemsController, SystemMuntinsController],
  providers: [SystemsService, SystemMuntinsService],
})
export class SystemsModule {}
