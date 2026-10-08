import { Body, Controller, Get, Header, Module, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/prisma/prisma.module';
import { Roles } from '@/auth/roles.decorator';
import { Public } from '@/auth/public.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { ReferralBankCipher } from './referral-bank';
import { ReferralsService } from './referrals.service';
import { RecoverReferralPayoutDto, RequestReferralPayoutDto, SaveReferralBankDto, SaveReferralProfileDto, SaveReferralRoleDefaultDto, SaveReferralSettingsDto, TransitionReferralPayoutDto } from './referrals.dto';

@Controller('referrals')
export class ReferralsController {
  constructor(private readonly service: ReferralsService) {}
  @Public() @Get('resolve/:code') @Header('Cache-Control', 'no-store')
  resolve(@Param('code') code: string) { return this.service.resolve(code); }

  @Roles('client', 'dealer') @Get('me') @Header('Cache-Control', 'no-store')
  dashboard(@Req() req: { user: AuthUser }, @Query('referralsPage') referralsPage?: string,
    @Query('rewardsPage') rewardsPage?: string, @Query('payoutsPage') payoutsPage?: string) {
    return this.service.dashboard(req.user.id, referralsPage == null ? 0 : Number(referralsPage),
      rewardsPage == null ? 0 : Number(rewardsPage), payoutsPage == null ? 0 : Number(payoutsPage));
  }
  @Roles('client', 'dealer') @Post('me/link')
  link(@Req() req: { user: AuthUser }) { return this.service.createLink(req.user.id); }
  @Roles('client', 'dealer') @Put('me/bank') @Header('Cache-Control', 'no-store')
  bank(@Req() req: { user: AuthUser }, @Body() body: SaveReferralBankDto) { return this.service.saveBank(req.user.id, body); }
  @Roles('client', 'dealer') @Post('me/payouts')
  request(@Req() req: { user: AuthUser }, @Body() body: RequestReferralPayoutDto) { return this.service.requestPayout(req.user.id, body); }
  @Roles('client', 'dealer') @Post('me/payouts/:id/cancel')
  cancel(@Req() req: { user: AuthUser }, @Param('id', ParseIntPipe) id: number) { return this.service.cancelPayout(req.user.id, id); }

  @Roles('admin') @Get('admin') @Header('Cache-Control', 'no-store')
  list(@Req() req: { user: AuthUser }, @Query('payoutsPage') page?: string, @Query('payoutStatus') status?: string) {
    return this.service.listAdmin(req.user.id, page == null ? 0 : Number(page), status ?? 'OPEN');
  }
  @Roles('admin') @Get('admin/role-defaults') @Header('Cache-Control', 'no-store')
  listRoleDefaults(@Req() req: { user: AuthUser }) { return this.service.listAdminRoleDefaults(req.user.id); }
  @Roles('admin') @Get('admin/users') @Header('Cache-Control', 'no-store')
  listUsers(@Req() req: { user: AuthUser }, @Query('q') q?: string, @Query('page') page?: string) {
    return this.service.listAdminUsers(req.user.id, q, page == null ? 0 : Number(page));
  }
  @Roles('admin') @Patch('admin/users/:id')
  saveProfile(@Req() req: { user: AuthUser }, @Param('id', ParseIntPipe) id: number, @Body() body: SaveReferralProfileDto) {
    return this.service.saveProfile(req.user.id, id, body);
  }
  @Roles('admin') @Patch('admin/settings')
  settings(@Req() req: { user: AuthUser }, @Body() body: SaveReferralSettingsDto) { return this.service.saveSettings(req.user.id, body); }
  @Roles('admin') @Patch('admin/role-defaults/:role')
  roleDefaults(@Req() req: { user: AuthUser }, @Param('role') role: string, @Body() body: SaveReferralRoleDefaultDto) {
    return this.service.saveRoleDefault(req.user.id, role, body);
  }
  @Roles('admin') @Post('admin/payouts/:id/bank') @Header('Cache-Control', 'no-store')
  reveal(@Req() req: { user: AuthUser }, @Param('id', ParseIntPipe) id: number) { return this.service.revealBank(req.user.id, id); }
  @Roles('admin') @Post('admin/payouts/:id/transition')
  transition(@Req() req: { user: AuthUser }, @Param('id', ParseIntPipe) id: number, @Body() body: TransitionReferralPayoutDto) {
    return this.service.transition(req.user.id, id, body);
  }
  @Roles('admin') @Post('admin/payouts/:id/recover')
  recover(@Req() req: { user: AuthUser }, @Param('id', ParseIntPipe) id: number, @Body() body: RecoverReferralPayoutDto) {
    return this.service.recover(req.user.id, id, body);
  }
}

@Module({ imports: [PrismaModule, ConfigModule], controllers: [ReferralsController], providers: [ReferralsService, ReferralBankCipher] })
export class ReferralsModule {}
