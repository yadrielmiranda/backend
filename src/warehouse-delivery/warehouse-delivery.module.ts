import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { WarehouseDeliveryController } from './warehouse-delivery.controller';
import { WarehouseDeliveryService } from './warehouse-delivery.service';

@Module({
  imports: [PrismaModule],
  controllers: [WarehouseDeliveryController],
  providers: [WarehouseDeliveryService],
  exports: [WarehouseDeliveryService],
})
export class WarehouseDeliveryModule {}
