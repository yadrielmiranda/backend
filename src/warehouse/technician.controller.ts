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
  FactoryPickupRunFinishDto,
  FactoryPickupRunScanDto,
  WarehouseReceiptDto,
  WarehouseReleaseDto,
  WarehouseInstallationDeliveryDto,
  WarehouseCustomerDeliveryDto,
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

  @Get('warehouse/inventory/po') warehouseInventoryByPo(@Query() query: Record<string, string>, @Req() req: Request) {
    return this.warehouse.technicianWarehouseInventoryByPo(query, req.user as AuthUser);
  }

  @Get('warehouse/units/:barcode') warehouseUnit(@Param('barcode') barcode: string, @Req() req: Request) {
    return this.warehouse.technicianWarehouseUnit(barcode, req.user as AuthUser);
  }

  @Get('warehouse/history') warehouseHistory(@Query() query: Record<string, string>, @Req() req: Request) {
    return this.warehouse.technicianWarehouseHistory(query, req.user as AuthUser);
  }

  @Get('customer-delivery-options') customerDeliveryOptions(@Query() query: Record<string, string>, @Req() req: Request) {
    return this.warehouse.technicianCustomerDeliveryOptions(query, req.user as AuthUser);
  }

  @Get('customer-deliveries/:id') customerDelivery(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.warehouse.technicianCustomerDelivery(id, req.user as AuthUser);
  }

  @Post('customer-deliveries') deliverToCustomer(@Body() dto: WarehouseCustomerDeliveryDto, @Req() req: Request) {
    return this.warehouse.technicianDeliverToCustomer(dto, req.user as AuthUser);
  }

  @Get('pickups/current') currentPickup(@Req() req: Request) {
    return this.warehouse.factoryPickupCurrent(req.user as AuthUser);
  }

  @Get('pickups') pickups(@Query() query: Record<string, string>, @Req() req: Request) {
    return this.warehouse.factoryPickups(query, req.user as AuthUser);
  }

  @Get('pickups/:id') pickup(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.warehouse.factoryPickup(id, req.user as AuthUser);
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
  @Post('releases') release(@Body() dto: WarehouseReleaseDto, @Req() req: Request) {
    return this.warehouse.technicianRelease(dto, req.user as AuthUser);
  }
  @Post('installation-deliveries') deliverToInstallation(
    @Body() dto: WarehouseInstallationDeliveryDto, @Req() req: Request,
  ) {
    return this.warehouse.deliverToInstallation(dto, req.user as AuthUser);
  }
}
