import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { SaveWarehouseDeliveryDto } from './dto/save-warehouse-delivery.dto';
import { WarehouseDeliveryService } from './warehouse-delivery.service';

@Controller('warehouse-delivery')
export class WarehouseDeliveryController {
  constructor(private readonly warehouse: WarehouseDeliveryService) {}

  @Get()
  @Roles('admin')
  find() {
    return this.warehouse.find();
  }

  @Put()
  @Roles('admin')
  save(@Body() dto: SaveWarehouseDeliveryDto, @Req() request: Request) {
    return this.warehouse.save(dto, (request.user as AuthUser).id);
  }

  @Get('pickup-address')
  async pickupAddress() {
    return { address: await this.warehouse.pickupAddress() };
  }
}
