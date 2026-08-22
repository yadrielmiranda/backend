import {
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { DeliveriesService } from './deliveries.service';
import { CreateDeliveryDto, ScheduleDeliveryDto } from './dto/delivery.dto';

@Controller('orders')
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Post(':orderId/fulfillment/pickup')
  selectPickup(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Req() req: Request,
  ) {
    return this.deliveries.selectPickup(orderId, req.user as AuthUser);
  }

  @Post(':orderId/fulfillment/pickup/complete')
  @Roles('admin', 'operator')
  completePickup(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Req() req: Request,
  ) {
    return this.deliveries.completePickup(orderId, req.user as AuthUser);
  }

  @Post(':orderId/deliveries')
  createDelivery(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: CreateDeliveryDto,
    @Req() req: Request,
  ) {
    return this.deliveries.createDelivery(orderId, dto, req.user as AuthUser);
  }

  @Patch('deliveries/:deliveryId/schedule')
  @Roles('admin', 'operator')
  scheduleDelivery(
    @Param('deliveryId', ParseIntPipe) deliveryId: number,
    @Body() dto: ScheduleDeliveryDto,
    @Req() req: Request,
  ) {
    return this.deliveries.scheduleDelivery(
      deliveryId,
      dto,
      req.user as AuthUser,
    );
  }

  @Post('deliveries/:deliveryId/complete')
  @Roles('admin', 'operator')
  completeDelivery(
    @Param('deliveryId', ParseIntPipe) deliveryId: number,
    @Req() req: Request,
  ) {
    return this.deliveries.completeDelivery(deliveryId, req.user as AuthUser);
  }
}
