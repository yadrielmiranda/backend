// @/payments/payments.module.ts
import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { LogsModule } from '@/logs/logs.module';
import { ConfigModule } from '@nestjs/config';
import { InstallationModule } from '@/installation/installation.module';

@Module({
  imports: [PrismaModule, LogsModule, ConfigModule, InstallationModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
