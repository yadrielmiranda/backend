// @/orders/orders.module.ts
import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { NotificationsModule } from '@/notifications/notifications.module';
import { LogsModule } from '@/logs/logs.module';
import { InstallationModule } from '@/installation/installation.module';
import { FactoryImportController } from './factory-import/factory-import.controller';
import { FactoryImportService } from './factory-import/factory-import.service';

@Module({
  imports: [PrismaModule, NotificationsModule, LogsModule, InstallationModule],
  controllers: [OrdersController, FactoryImportController],
  providers: [OrdersService, FactoryImportService],
  exports: [OrdersService],
})
export class OrdersModule {}
