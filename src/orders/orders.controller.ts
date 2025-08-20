import { Controller, Post, Body, UseGuards, Req, Get, Param, ParseIntPipe, Patch } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { JwtAuthGuard } from 'src/auth/guards/auth/auth.guard';
import { Request } from 'express';
import { UpdateOrderDto } from './dto/update-order.dto';
import { Roles } from 'src/auth/roles.decorator';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';

@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}


  @Post()
  create(@Body() createOrderDto: CreateOrderDto, @Req() req: Request) {
    const user = req.user as { id: number };
    return this.ordersService.createOrderFromEstimate(createOrderDto.estimateId, user.id);
  }

  // Endpoint para obtener todas las órdenes
  @Get()
  findAll() {
    return this.ordersService.findAll();
  }
  
  // Endpoint para obtener todos los estados de orden
  @Get('statuses')
  findAllStatuses() {
      return this.ordersService.findAllStatuses();
  }

  // Endpoint para obtener una orden por ID
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.ordersService.findOne(id);
  }

  // Endpoint para actualizar una orden
  @Patch(':id')
  @Roles('admin') // <-- 3. Especifica que SOLO el rol 'admin' puede acceder
  @UseGuards(RolesGuard)
  update(@Param('id', ParseIntPipe) id: number, @Body() updateOrderDto: UpdateOrderDto) {
    return this.ordersService.update(id, updateOrderDto);
  }
}