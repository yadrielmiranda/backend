import { Injectable } from '@nestjs/common';
import type { DealerPreferredLanguage, Prisma } from '@prisma/client';
import { WelcomeSmsService } from '@/sms/welcome-sms.service';
import { WelcomeEmailService } from './welcome-email.service';

@Injectable()
export class AccountWelcomeService {
  constructor(private readonly email: WelcomeEmailService, private readonly sms: WelcomeSmsService) {}

  /** Only account-creation paths call this, within their existing transaction. */
  async enqueue(userId: number, db: Prisma.TransactionClient, approvalLanguage?: DealerPreferredLanguage): Promise<void> {
    await this.email.enqueue(userId, db, approvalLanguage);
    await this.sms.enqueue(userId, db, approvalLanguage);
  }
}
