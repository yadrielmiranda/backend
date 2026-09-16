// @/payments/payments.controller.ts
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { PaymentsService } from './payments.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { Public } from '@/auth/public.decorator';
import { Roles } from '@/auth/roles.decorator';
import { CreatePublicCheckoutSessionDto } from './dto/create-public-checkout-session.dto';
import { RecordManualPaymentDto } from './dto/record-manual-payment.dto';
import { InstallationPricingInterceptor } from '@/installation/installation-pricing.interceptor';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Roles('admin', 'dealer')
  @UseInterceptors(InstallationPricingInterceptor)
  @Post('installations/:jobId/accept-dealer-measurements')
  acceptDealerMeasurements(
    @Param('jobId', ParseIntPipe) jobId: number,
    @Req() req: Request,
  ) {
    return this.payments.acceptDealerMeasurements(jobId, req.user as AuthUser);
  }

  @Roles('admin')
  @Post('estimates/:estimateId/approve-order')
  approveOrder(@Param('estimateId', ParseIntPipe) estimateId: number, @Req() req: Request) {
    return this.payments.approveOrder(estimateId, req.user as AuthUser);
  }

  @Public()
  @Get('public/:token/context')
  getPublicPaymentContext(@Param('token') token: string) {
    return this.payments.getPublicPaymentContext(token);
  }

  @Public()
  @Post('public/:token/checkout-session')
  createPublicCheckoutSession(
    @Param('token') token: string,
    @Body() dto: CreatePublicCheckoutSessionDto,
  ) {
    return this.payments.createCheckoutSessionForPublicToken({
      token,
      installationDepositTermsAccepted: dto.installationDepositTermsAccepted,
      cityFeeAccepted: dto.cityFeeAccepted,
      agreementId: dto.agreementId,
      sequences: dto.sequences,
      payFullBalance: dto.payFullBalance,
      expectedBalance: dto.expectedBalance,
    });
  }

  @Public()
  @Post('public/:token/checkout-session/cancel')
  cancelPublicCheckoutSession(
    @Param('token') token: string,
    @Body() dto: CreatePublicCheckoutSessionDto,
  ) {
    return this.payments.cancelCheckoutSessionForPublicToken({
      token,
      type: dto.type,
      sequence: dto.sequence,
      checkoutRef: dto.checkoutRef,
    });
  }

  @Post('manual')
  @Roles('admin', 'dealer')
  recordManualPayment(
    @Body() dto: RecordManualPaymentDto,
    @Req() req: Request,
  ) {
    return this.payments.recordManualPayment({
      ...dto,
      actor: req.user as AuthUser,
    });
  }

  // requiere login (guards globales ya aplican)
  @Post('checkout-session')
  async createCheckoutSession(
    @Body() dto: CreateCheckoutSessionDto,
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    return this.payments.createCheckoutSessionForEstimate({
      estimateId: dto.estimateId,
      type: dto.type,
      sequence: dto.sequence,
      installationDepositTermsAccepted: dto.installationDepositTermsAccepted,
      cityFeeAccepted: dto.cityFeeAccepted,
      materialAccepted: dto.materialAccepted,
      sequences: dto.sequences,
      payFullBalance: dto.payFullBalance,
      expectedBalance: dto.expectedBalance,
      user,
    });
  }

  @Post('checkout-session/cancel')
  async cancelCheckoutSession(
    @Body() dto: CreateCheckoutSessionDto,
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    return this.payments.cancelCheckoutSessionForEstimate({
      estimateId: dto.estimateId,
      type: dto.type,
      sequence: dto.sequence,
      checkoutRef: dto.checkoutRef,
      user,
    });
  }

  // Webhook PUBLIC
  @Public()
  @Post('webhook')
  async webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') signature: string | undefined,
    @Res() res: Response,
  ) {
    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (!rawBody) return res.status(400).send('Missing raw body');
    if (!signature) return res.status(400).send('Missing stripe-signature');

    await this.payments.handleStripeWebhook(rawBody, signature);

    return res.status(200).json({ received: true });
  }
}
