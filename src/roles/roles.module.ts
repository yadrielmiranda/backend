import { Module } from '@nestjs/common';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { LogsModule } from '@/logs/logs.module';

@Module({
  imports: [PrismaModule, LogsModule],
  controllers: [RolesController],
  providers: [RolesService],
})
export class RolesModule {}
