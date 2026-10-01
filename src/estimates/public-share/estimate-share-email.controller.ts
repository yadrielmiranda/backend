import { Body, Controller, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { ShareEstimateEmailDto } from '../dto/share-estimate-email.dto';
import { EstimateShareEmailService } from './estimate-share-email.service';

@UseGuards(JwtAuthGuard)
@Controller('estimates')
export class EstimateShareEmailController {
  constructor(private readonly service: EstimateShareEmailService) {}

  @Post(':id/share-email')
  @Roles('admin', 'dealer')
  send(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ShareEstimateEmailDto,
    @Req() req: Request,
  ) {
    return this.service.send(id, dto, req.user as AuthUser);
  }
}
