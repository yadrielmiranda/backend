// @/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { RegistrationAnalytics, RegistrationAnalyticsController } from './registration-analytics';
import { UsersModule } from '@/users/users.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { JwtStrategy } from './guards/auth/jwt.strategy';
import { LogsModule } from '@/logs/logs.module';
import { MailModule } from '@/mail/mail.module';
import { WelcomeEmailModule } from '@/mail/welcome-email.module';
import { SmsConsentModule } from '@/sms/sms-consent.module';
import { DeliveriesModule } from '@/deliveries/deliveries.module';

@Module({
  imports: [
    ConfigModule,
    UsersModule,
    MailModule,
    WelcomeEmailModule,
    SmsConsentModule,
    DeliveriesModule,
    PrismaModule,
    PassportModule,
    LogsModule, 

    // ✅ JWT usando .env (JWT_SECRET_KEY)
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET_KEY');
        if (!secret) {
          throw new Error('JWT_SECRET_KEY is not set in .env');
        }
        return {
          global: true,
          secret,
          signOptions: { expiresIn: '1d' },
        };
      },
    }),
  ],
  controllers: [AuthController, RegistrationAnalyticsController],
  providers: [AuthService, JwtStrategy, RegistrationAnalytics],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
