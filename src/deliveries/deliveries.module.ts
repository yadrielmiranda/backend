import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '@/prisma/prisma.module';
import { NotificationsModule } from '@/notifications/notifications.module';
import { LogsModule } from '@/logs/logs.module';
import { DeliveriesController } from './deliveries.controller';
import { DeliveriesService } from './deliveries.service';
import { GoogleRoutesService } from './google-routes.service';

@Module({
  imports: [HttpModule, PrismaModule, NotificationsModule, LogsModule],
  controllers: [DeliveriesController],
  providers: [DeliveriesService, GoogleRoutesService],
  exports: [DeliveriesService],
})
export class DeliveriesModule {}
