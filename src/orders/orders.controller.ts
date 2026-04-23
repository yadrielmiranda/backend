import {
  Controller,
  Req,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Body,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { Request } from 'express';
import { UpdateOrderDto } from './dto/update-order.dto';
import { Roles } from '@/auth/roles.decorator';
import { AuthUser } from '@/auth/types/auth-user.type';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get('statuses')
  findAllStatuses() {
    return this.ordersService.findAllStatuses();
  }

  @Get()
  findAll(@Req() req: Request) {
    return this.ordersService.findAllForUser(req.user as AuthUser);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.ordersService.findOneForUser(id, req.user as AuthUser);
  }

  // 🔒 admin + operator pueden cambiar status
  @Patch(':id')
  @Roles('admin', 'operator')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateOrderDto: UpdateOrderDto,
    @Req() req: Request,
  ) {
    return this.ordersService.update(id, updateOrderDto, req.user as AuthUser);
  }
}
