// @/users/users.module.ts
import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { LogsModule } from '@/logs/logs.module';
import { WelcomeEmailModule } from '@/mail/welcome-email.module';

@Module({
  imports: [PrismaModule, LogsModule, WelcomeEmailModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
