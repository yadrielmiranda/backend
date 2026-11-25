import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { NotificationsService } from '@/notifications/notifications.service';
import { WelcomeSmsService } from '@/sms/welcome-sms.service';
import { WelcomeEmailService } from './welcome-email.service';

@Injectable()
export class AccountWelcomeService {
  constructor(
    private readonly email: WelcomeEmailService,
    private readonly sms: WelcomeSmsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Record welcome messages and the admin notice in the account creation transaction. */
  async enqueue(userId: number, db: Prisma.TransactionClient, isDealerApproval = false): Promise<void> {
    await this.email.enqueue(userId, db, isDealerApproval);
    await this.sms.enqueue(userId, db, isDealerApproval);
    await this.notifications.notifyAdminsOfAccountCreation(userId, db);
  }
}
