import { Body, Controller, Get, Header, Param, ParseIntPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Roles } from '@/auth/roles.decorator';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { FactoryPaymentsService } from './factory-payments.service';
import {
  CreateFactoryManufacturerDto, CreateFactoryPaymentDto, ListFactoryPaymentsDto,
  SaveFactoryPaymentAccountDto, SyncFactoryPaymentTotalDto,
  UpdateFactoryManufacturerDto, VoidFactoryPaymentDto,
} from './factory-payments.dto';

@Controller('factory-payments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class FactoryPaymentsController {
  constructor(private readonly service: FactoryPaymentsService) {}

  @Get('manufacturers')
  @Header('Cache-Control', 'private, no-store')
  manufacturers() { return this.service.manufacturers(); }

  @Post('manufacturers')
  createManufacturer(@Body() dto: CreateFactoryManufacturerDto, @Req() req: { user: AuthUser }) {
    return this.service.saveManufacturer(dto, req.user.id);
  }

  @Patch('manufacturers/:id')
  updateManufacturer(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateFactoryManufacturerDto, @Req() req: { user: AuthUser }) {
    return this.service.saveManufacturer(dto, req.user.id, id);
  }

  @Get('orders')
  @Header('Cache-Control', 'private, no-store')
  list(@Query() query: ListFactoryPaymentsDto) { return this.service.list(query); }

  @Get('orders/:id')
  @Header('Cache-Control', 'private, no-store')
  detail(@Param('id', ParseIntPipe) id: number) { return this.service.detail(id); }

  @Put('orders/:id/account')
  saveAccount(@Param('id', ParseIntPipe) id: number, @Body() dto: SaveFactoryPaymentAccountDto, @Req() req: { user: AuthUser }) {
    return this.service.saveAccount(id, dto, req.user.id);
  }

  @Post('orders/:id/sync-total')
  syncTotal(@Param('id', ParseIntPipe) id: number, @Body() dto: SyncFactoryPaymentTotalDto, @Req() req: { user: AuthUser }) {
    return this.service.syncTotal(id, dto.version, req.user.id);
  }

  @Post('orders/:id/payments')
  addPayment(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateFactoryPaymentDto, @Req() req: { user: AuthUser }) {
    return this.service.addPayment(id, dto, req.user.id);
  }

  @Post('payments/:id/void')
  voidPayment(@Param('id', ParseIntPipe) id: number, @Body() dto: VoidFactoryPaymentDto, @Req() req: { user: AuthUser }) {
    return this.service.voidPayment(id, dto.reason, req.user.id);
  }
}
