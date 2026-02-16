// src/payments/payments.module.ts
import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { LogsModule } from 'src/logs/logs.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [PrismaModule, LogsModule, ConfigModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
