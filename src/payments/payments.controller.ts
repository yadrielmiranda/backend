// @/payments/payments.controller.ts
import { Controller, Post, Body, Req, Headers, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { PaymentsService } from './payments.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { Public } from '@/auth/public.decorator';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) { }

  // requiere login (guards globales ya aplican)
  @Post('checkout-session')
  async createCheckoutSession(@Body() dto: CreateCheckoutSessionDto, @Req() req: Request) {
    const user = req.user as AuthUser;

    return this.payments.createCheckoutSessionForEstimate({
      estimateId: dto.estimateId,
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
