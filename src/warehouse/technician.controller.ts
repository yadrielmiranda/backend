import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import {
  FactoryPickupRunCreateDto,
  FactoryPickupRunFinishDto,
  FactoryPickupRunScanDto,
  WarehouseReceiptDto,
  WarehouseInstallationDeliveryDto,
  WarehouseScanDto,
} from './warehouse.dto';
import { WarehouseService } from './warehouse.service';

// Superficie separada del almacén administrativo y de las cuentas comerciales.
@Controller('technician')
@Roles('technician')
export class TechnicianController {
  constructor(private readonly warehouse: WarehouseService) {}

  @Get('state') state(@Req() req: Request) {
    return this.warehouse.technicianState(req.user as AuthUser);
  }

  @Get('pending') pending(@Query() query: Record<string, string>, @Req() req: Request) {
    return this.warehouse.technicianPending(query, req.user as AuthUser);
  }

  @Get('pickups/current') currentPickup(@Req() req: Request) {
    return this.warehouse.factoryPickupCurrent(req.user as AuthUser);
  }

  @Get('pickups/po') pickupPo(
    @Query('poNumber') poNumber: string,
    @Req() req: Request,
  ) {
    return this.warehouse.factoryPickupPo(poNumber, req.user as AuthUser);
  }

  @Post('pickups') startPickup(
    @Body() dto: FactoryPickupRunCreateDto,
    @Req() req: Request,
  ) {
    return this.warehouse.startFactoryPickup(dto, req.user as AuthUser);
  }

  @Post('pickups/:id/scan') pickupScan(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: FactoryPickupRunScanDto,
    @Req() req: Request,
  ) {
    return this.warehouse.factoryPickupScan(id, dto, req.user as AuthUser);
  }

  @Post('pickups/:id/finish') finishPickup(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: FactoryPickupRunFinishDto,
    @Req() req: Request,
  ) {
    return this.warehouse.finishFactoryPickup(id, dto, req.user as AuthUser);
  }

  @Post('scan') scan(@Body() dto: WarehouseScanDto, @Req() req: Request) {
    return this.warehouse.technicianScan(dto, req.user as AuthUser);
  }

  @Post('receipts') receive(@Body() dto: WarehouseReceiptDto, @Req() req: Request) {
    return this.warehouse.receive(dto, req.user as AuthUser);
  }
  @Post('installation-deliveries') deliverToInstallation(
    @Body() dto: WarehouseInstallationDeliveryDto, @Req() req: Request,
  ) {
    return this.warehouse.deliverToInstallation(dto, req.user as AuthUser);
  }
}
