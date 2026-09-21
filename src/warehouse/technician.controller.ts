import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { WarehouseReceiptDto, WarehouseScanDto } from './warehouse.dto';
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

  @Post('scan') scan(@Body() dto: WarehouseScanDto, @Req() req: Request) {
    return this.warehouse.technicianScan(dto, req.user as AuthUser);
  }

  @Post('receipts') receive(@Body() dto: WarehouseReceiptDto, @Req() req: Request) {
    return this.warehouse.receive(dto, req.user as AuthUser);
  }
}
