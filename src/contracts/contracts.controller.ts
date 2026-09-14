import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request, Response } from 'express';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { Roles } from '@/auth/roles.decorator';
import { Public } from '@/auth/public.decorator';
import { ContractsService } from './contracts.service';
import { PrepareAgreementDto, SignAgreementDto } from './contracts.dto';

const mode = (value: string = 'detailed'): 'detailed' | 'total' => {
  if (value !== 'detailed' && value !== 'total')
    throw new BadRequestException('Invalid customer report.');
  return value;
};
const kind = (value: string): 'contract' | 'quote' | 'signed' => {
  if (!['contract', 'quote', 'signed'].includes(value))
    throw new BadRequestException('Invalid document.');
  return value as 'contract' | 'quote' | 'signed';
};
function sendPdf(res: Response, bytes: Buffer, filename: string) {
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${filename}.pdf"`,
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.send(bytes);
}

@Controller('contracts')
export class ContractsController {
  constructor(private readonly service: ContractsService) {}
  @Get('me') @Roles('dealer') get(@Req() req: Request) {
    return this.service.dealerContract(req.user as AuthUser);
  }
  @Post('me')
  @Roles('dealer')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  upload(@Req() req: Request, @UploadedFile() file: Express.Multer.File) {
    return this.service.upload(req.user as AuthUser, file);
  }
  @Delete('me') @Roles('dealer') remove(@Req() req: Request) {
    return this.service.removeDefault(req.user as AuthUser);
  }
  @Get('me/:id/pdf')
  @Roles('dealer')
  async pdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    sendPdf(
      res,
      await this.service.dealerContractPdf(id, req.user as AuthUser),
      'dealer-contract',
    );
  }
  @Get('estimates/:id')
  info(
    @Param('id', ParseIntPipe) id: number,
    @Query('pricingMode') pricingMode: string,
    @Req() req: Request,
  ) {
    return this.service.estimateInfo(
      id,
      mode(pricingMode),
      req.user as AuthUser,
    );
  }
  @Post('estimates/:id')
  @Roles('dealer')
  prepare(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PrepareAgreementDto,
    @Req() req: Request,
  ) {
    return this.service.prepare(
      id,
      dto.pricingMode,
      dto.useLatestContract === true,
      req.user as AuthUser,
    );
  }
  @Get('estimates/:id/agreements/:agreementId/:kind/pdf')
  async document(
    @Param('id', ParseIntPipe) id: number,
    @Param('agreementId', ParseUUIDPipe) agreementId: string,
    @Param('kind') documentKind: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    sendPdf(
      res,
      await this.service.ownerDocument(
        id,
        agreementId,
        kind(documentKind),
        req.user as AuthUser,
      ),
      `agreement-${id}-${documentKind}`,
    );
  }
}

@Public()
@Controller('public/contracts/:token')
export class PublicContractsController {
  constructor(private readonly service: ContractsService) {}
  @Get() info(
    @Param('token') token: string,
    @Query('agreementId', ParseUUIDPipe) agreementId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.set('Cache-Control', 'private, no-store');
    return this.service.publicInfo(token, agreementId);
  }
  @Get('agreements/:id/snapshot') snapshot(
    @Param('token') token: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.set('Cache-Control', 'private, no-store');
    return this.service.publicSnapshot(token, id);
  }
  @Get('agreements/:id/:kind/pdf')
  async document(
    @Param('token') token: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') documentKind: string,
    @Res() res: Response,
  ) {
    sendPdf(
      res,
      await this.service.publicDocument(token, id, kind(documentKind)),
      `agreement-${documentKind}`,
    );
  }
  @Post('agreements/:id/sign') sign(
    @Param('token') token: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignAgreementDto,
    @Req() req: Request,
  ) {
    return this.service.sign(token, id, dto, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  }
}
