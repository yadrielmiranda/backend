import {
  Controller,
  Post,
  Body,  
  Req,
  Get,
  Param,
  ParseIntPipe,
  Patch,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { Request } from 'express';
import { UpdateOrderDto } from './dto/update-order.dto';
import { Roles } from 'src/auth/roles.decorator';
import { AuthUser } from 'src/auth/types/auth-user.type';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  // Crear orden desde estimate (solo el dueño puede: validado en service)
  @Post()
  create(@Body() dto: CreateOrderDto, @Req() req: Request) {
    const user = req.user as AuthUser;
    return this.ordersService.createOrderFromEstimate(dto.estimateId, user.id);
  }

  // Estados (normalmente cualquiera autenticado puede leerlos)
  @Get('statuses')
  findAllStatuses() {
    return this.ordersService.findAllStatuses();
  }

  // ✅ admin/operator: todas
  // ✅ client/dealer: solo las suyas
  @Get()
  findAll(@Req() req: Request) {
    return this.ordersService.findAllForUser(req.user as AuthUser);
  }

  // ✅ admin/operator: cualquiera
  // ✅ client/dealer: solo si es dueño
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
  ) {
    return this.ordersService.update(id, updateOrderDto);
  }
}
