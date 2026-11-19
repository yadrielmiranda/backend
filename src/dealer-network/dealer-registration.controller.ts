import { Body, Controller, Get, Header, Param, ParseIntPipe, Patch, Post, Put, Req } from '@nestjs/common';
import { Public } from '@/auth/public.decorator';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { ReviewDealerRegistrationDto, SubmitDealerRegistrationDto, UpdateDealerInviteDto } from './dealer-network.dto';
import { DealerRegistrationService } from './dealer-registration.service';

@Controller('dealer-network')
@Roles('admin', 'dealer')
export class DealerRegistrationController {
  constructor(private readonly service: DealerRegistrationService) {}

  @Get('invitation')
  @Header('Cache-Control', 'no-store')
  invitation(@Req() req: { user: AuthUser }) {
    return this.service.getInvitation(req.user);
  }

  @Put('invitation')
  saveInvitation(@Req() req: { user: AuthUser }, @Body() dto: UpdateDealerInviteDto) {
    return this.service.saveInvitation(req.user, dto.markupPercent);
  }

  @Get('members/:id/invitation')
  @Roles('admin')
  @Header('Cache-Control', 'no-store')
  memberInvitation(@Req() req: { user: AuthUser }, @Param('id', ParseIntPipe) id: number) {
    return this.service.getMemberInvitation(req.user, id);
  }

  @Public()
  @Get('invitations/:token')
  @Header('Cache-Control', 'no-store')
  publicInvitation(@Param('token') token: string) {
    return this.service.publicInvitation(token);
  }

  @Public()
  @Post('invitations/:token')
  submit(@Param('token') token: string, @Body() dto: SubmitDealerRegistrationDto) {
    return this.service.submit(token, dto);
  }

  @Get('registration-requests')
  @Header('Cache-Control', 'no-store')
  listPending(@Req() req: { user: AuthUser }) {
    return this.service.listPending(req.user);
  }

  @Patch('registration-requests/:id')
  review(@Req() req: { user: AuthUser }, @Param('id', ParseIntPipe) id: number, @Body() dto: ReviewDealerRegistrationDto) {
    return this.service.review(req.user, id, dto.approve);
  }
}
