import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { WarehouseController } from './warehouse.controller';
import { WarehouseService } from './warehouse.service';
import { TechnicianController } from './technician.controller';

@Module({
  imports: [PrismaModule],
  controllers: [WarehouseController, TechnicianController],
  providers: [WarehouseService],
})
export class WarehouseModule {}
