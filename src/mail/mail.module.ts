import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MailService } from './mail.service';
import { PrismaModule } from '@/prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
