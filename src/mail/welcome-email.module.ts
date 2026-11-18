import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { NotificationsModule } from '@/notifications/notifications.module';
import { WelcomeEmailService } from './welcome-email.service';
import { WelcomeSmsService } from '@/sms/welcome-sms.service';
import { AccountWelcomeService } from './account-welcome.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  providers: [WelcomeEmailService, WelcomeSmsService, AccountWelcomeService],
  exports: [WelcomeEmailService, AccountWelcomeService],
})
export class WelcomeEmailModule {}
