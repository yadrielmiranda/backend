import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { WarehouseController } from './warehouse.controller';
import { WarehouseService } from './warehouse.service';
import { TechnicianController } from './technician.controller';
import { ExternalPoController } from './external-po/external-po.controller';
import { ExternalPoService } from './external-po/external-po.service';

@Module({
  imports: [PrismaModule],
  controllers: [WarehouseController, TechnicianController, ExternalPoController],
  providers: [WarehouseService, ExternalPoService],
})
export class WarehouseModule {}
