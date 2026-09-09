import { Module } from '@nestjs/common';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { SmsConsentModule } from '@/sms/sms-consent.module';
import { NotificationSmsService } from './notification-sms.service';
import { NotificationEmailService } from './notification-email.service';

@Module({
  imports: [PrismaModule, JwtModule, ConfigModule, SmsConsentModule],
  providers: [
    NotificationsGateway,
    NotificationsService,
    NotificationSmsService,
    NotificationEmailService,
  ],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
