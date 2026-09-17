import {
  Body, Controller, Get, Header, Param, ParseIntPipe, Post, Req, UseInterceptors,
} from '@nestjs/common';
import { NoFilesInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { Public } from '@/auth/public.decorator';
import { Roles } from '@/auth/roles.decorator';
import { AuthUser } from '@/auth/types/auth-user.type';
import { AllowBeforePlatformTerms } from './platform-terms.decorator';
import { AcceptPlatformTermsDto, PublishPlatformTermsTextDto } from './platform-terms.dto';
import { PlatformTermsService } from './platform-terms.service';

@Controller('platform-terms')
@AllowBeforePlatformTerms()
export class PlatformTermsController {
  constructor(private readonly terms: PlatformTermsService) {}

  @Public() @Get('current') @Header('Cache-Control', 'no-store')
  current() { return this.terms.current(); }

  @Get('status') @Header('Cache-Control', 'no-store')
  status(@Req() req: Request) { return this.terms.status((req.user as AuthUser).id); }

  @Post('accept')
  accept(@Req() req: Request, @Body() dto: AcceptPlatformTermsDto) {
    return this.terms.accept((req.user as AuthUser).id, dto.accepted, dto.versionId);
  }

  @Get('my-history') @Header('Cache-Control', 'no-store')
  myHistory(@Req() req: Request) { return this.terms.myHistory((req.user as AuthUser).id); }

  @Roles('admin') @Get('admin') @Header('Cache-Control', 'no-store')
  administration(@Req() req: Request) { return this.terms.administration(req.user as AuthUser); }

  @Roles('admin') @Get('admin/:id/document') @Header('Cache-Control', 'private, no-store')
  administrationDocument(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.terms.administrationDocument(req.user as AuthUser, id);
  }

  @Roles('admin') @Post('publish-text')
  @UseInterceptors(NoFilesInterceptor({ limits: { fieldSize: 2 * 1024 * 1024, fields: 2 } }))
  publishText(@Req() req: Request, @Body() dto: PublishPlatformTermsTextDto) {
    return this.terms.publishText(req.user as AuthUser, dto.content, dto.currentVersionId);
  }

  @Public() @Get(':id/document') @Header('Cache-Control', 'no-store')
  document(@Param('id', ParseIntPipe) id: number) { return this.terms.document(id); }

}
