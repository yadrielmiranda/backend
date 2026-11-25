import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { ClientDeliveryService } from './client-delivery.service';
import { ClientDeliveryAddressDto, ClientDeliveryDecisionDto } from './dto/client-delivery.dto';

@Roles('client')
@Controller('client-delivery')
export class ClientDeliveryController {
  constructor(private readonly clientDelivery: ClientDeliveryService) {}

  @Get('coverage')
  status(@Req() req: Request, @Query('estimateId', new ParseIntPipe({ optional: true })) estimateId?: number) {
    return this.clientDelivery.status((req.user as AuthUser).id, estimateId);
  }

  @Post('coverage')
  check(@Req() req: Request, @Body() address: ClientDeliveryAddressDto) {
    return this.clientDelivery.check((req.user as AuthUser).id, address);
  }

  @Post('coverage/saved')
  checkSaved(@Req() req: Request) {
    return this.clientDelivery.check((req.user as AuthUser).id);
  }

  @Post('estimates/:estimateId/acknowledge')
  acknowledge(@Req() req: Request, @Param('estimateId', ParseIntPipe) estimateId: number,
    @Body() dto: ClientDeliveryDecisionDto) {
    return this.clientDelivery.acknowledge((req.user as AuthUser).id, estimateId, dto.choice, dto.verificationKey);
  }
}
