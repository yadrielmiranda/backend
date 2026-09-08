import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/prisma/prisma.module';
import { SmsConsentController } from './sms-consent.controller';
import { SmsConsentService } from './sms-consent.service';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [SmsConsentController],
  providers: [SmsConsentService],
  exports: [SmsConsentService],
})
export class SmsConsentModule {}
