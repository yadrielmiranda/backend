// @/payments/payments.module.ts
import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { LogsModule } from '@/logs/logs.module';
import { ConfigModule } from '@nestjs/config';
import { InstallationModule } from '@/installation/installation.module';
import { NotificationsModule } from '@/notifications/notifications.module';
import { MaterialsModule } from '@/materials/materials.module';

@Module({
  imports: [
    PrismaModule,
    LogsModule,
    ConfigModule,
    InstallationModule,
    NotificationsModule,
    MaterialsModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
