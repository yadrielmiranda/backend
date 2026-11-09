import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { FactoryPaymentsController } from './factory-payments.controller';
import { FactoryPaymentsService } from './factory-payments.service';

@Module({
  imports: [PrismaModule],
  controllers: [FactoryPaymentsController],
  providers: [FactoryPaymentsService],
})
export class FactoryPaymentsModule {}
