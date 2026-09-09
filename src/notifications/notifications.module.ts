import { Module } from '@nestjs/common';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SmsConsentModule } from '@/sms/sms-consent.module';
import { NotificationSmsService } from './notification-sms.service';
import { NotificationEmailService } from './notification-email.service';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    SmsConsentModule,
    // El socket valida las cookies con la misma clave que firma el login.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET_KEY');
        if (!secret) {
          throw new Error('JWT_SECRET_KEY is not set in .env');
        }
        return { secret };
      },
    }),
  ],
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
