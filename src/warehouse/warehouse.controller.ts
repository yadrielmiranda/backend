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
import { WarehouseService } from './warehouse.service';
import {
  WarehouseRequestDto,
  WarehouseScanDto,
  WarehousePartsDto,
  WarehouseCountScanDto,
  WarehouseCountCloseDto,
} from './warehouse.dto';

@Controller('warehouse')
@Roles('admin', 'operator')
export class WarehouseController {
  constructor(private readonly warehouse: WarehouseService) {}

  @Get('inventory') inventory(
    @Query() query: Record<string, string>,
    @Req() req: Request,
  ) {
    return this.warehouse.inventory(query, req.user as AuthUser);
  }
  @Get('units/:barcode') unit(
    @Param('barcode') barcode: string,
    @Req() req: Request,
  ) {
    return this.warehouse.unit(barcode, req.user as AuthUser);
  }
  @Get('history') history(
    @Query() query: Record<string, string>,
    @Req() req: Request,
  ) {
    return this.warehouse.history(query, req.user as AuthUser);
  }
  @Post('scan') scan(@Body() dto: WarehouseScanDto, @Req() req: Request) {
    return this.warehouse.scan(dto, req.user as AuthUser);
  }
  @Post('movements/:id/undo') undo(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: WarehouseRequestDto,
    @Req() req: Request,
  ) {
    return this.warehouse.undo(id, dto, req.user as AuthUser);
  }
  @Post('units/:barcode/parts')
  @Roles('admin')
  parts(
    @Param('barcode') barcode: string,
    @Body() dto: WarehousePartsDto,
    @Req() req: Request,
  ) {
    return this.warehouse.setParts(barcode, dto, req.user as AuthUser);
  }
  @Get('counts') counts(@Req() req: Request) {
    return this.warehouse.counts(req.user as AuthUser);
  }
  @Post('counts') startCount(
    @Body() dto: WarehouseRequestDto,
    @Req() req: Request,
  ) {
    return this.warehouse.startCount(dto, req.user as AuthUser);
  }
  @Get('counts/:id') count(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: Record<string, string>,
    @Req() req: Request,
  ) {
    return this.warehouse.count(id, query, req.user as AuthUser);
  }
  @Post('counts/:id/scan') countScan(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: WarehouseCountScanDto,
    @Req() req: Request,
  ) {
    return this.warehouse.countScan(id, dto, req.user as AuthUser);
  }
  @Post('counts/:id/close') closeCount(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: WarehouseCountCloseDto,
    @Req() req: Request,
  ) {
    return this.warehouse.closeCount(id, dto, req.user as AuthUser);
  }
}
