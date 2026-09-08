import { Body, Controller, ForbiddenException, Get, Header, HttpCode, Patch, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { Public } from '@/auth/public.decorator';
import { SmsConsentService } from './sms-consent.service';
import { UpdateSmsConsentDto } from './dto/update-sms-consent.dto';
import { validateTwilioSignature } from './twilio-signature';

@Controller('sms')
export class SmsConsentController {
  constructor(private readonly service: SmsConsentService, private readonly config: ConfigService) {}

  @Public()
  @Get('program')
  @Header('Cache-Control', 'no-store')
  getProgram() { return this.service.getProgram(); }

  @Get('preferences')
  @Header('Cache-Control', 'no-store')
  getPreferences(@Req() req: Request) {
    return this.service.getPreferences((req.user as AuthUser).id);
  }

  @Patch('preferences')
  updatePreferences(@Req() req: Request, @Body() dto: UpdateSmsConsentDto) {
    // El cliente nunca elige a qué usuario pertenece la autorización.
    return this.service.updatePreferences((req.user as AuthUser).id, dto);
  }

  @Public()
  @Post('twilio/incoming')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async receiveTwilio(@Req() req: Request) {
    const token = this.config.get<string>('TWILIO_AUTH_TOKEN')?.trim();
    const account = this.config.get<string>('TWILIO_ACCOUNT_SID')?.trim();
    const publicUrl = this.config.get<string>('TWILIO_INBOUND_WEBHOOK_URL')?.trim();
    const messagingService = this.config.get<string>('TWILIO_MESSAGING_SERVICE_SID')?.trim();
    const sender = this.config.get<string>('TWILIO_FROM_NUMBER')?.trim();
    if (!token || !account || !publicUrl || (!messagingService && !sender)) {
      throw new ServiceUnavailableException('SMS callbacks are not configured.');
    }
    // Se firma la URL pública exacta; no se confía en Host ni X-Forwarded-*.
    const parameters = req.body as Record<string, unknown>;
    if (!req.is('application/x-www-form-urlencoded') || !parameters ||
      !validateTwilioSignature(token, publicUrl, req.get('X-Twilio-Signature'), parameters) ||
      parameters.AccountSid !== account ||
      (messagingService ? parameters.MessagingServiceSid !== messagingService : parameters.To !== sender)) {
      throw new ForbiddenException('Invalid SMS callback.');
    }
    const action = parameters.OptOutType;
    if ((action === 'STOP' || action === 'START') &&
      /^\+1\d{10}$/.test(parameters.From) && /^(?:SM|MM)[0-9a-fA-F]{32}$/.test(parameters.MessageSid)) {
      await this.service.recordProviderChoice(parameters.From, parameters.MessageSid, action);
    }
    // Advanced Opt-Out envía la respuesta; no duplicamos confirmaciones ni HELP.
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  }
}
