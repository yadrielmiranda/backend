import { Module } from '@nestjs/common';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [PrismaModule, JwtModule],
  providers: [NotificationsGateway, NotificationsService],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}