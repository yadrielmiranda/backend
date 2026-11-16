import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { NotificationsModule } from '@/notifications/notifications.module';
import { WelcomeEmailService } from './welcome-email.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  providers: [WelcomeEmailService],
  exports: [WelcomeEmailService],
})
export class WelcomeEmailModule {}
