import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { NotificationSmsService } from '@/notifications/notification-sms.service';
import { WelcomeSmsService } from '@/sms/welcome-sms.service';
import { AccountWelcomeService } from './account-welcome.service';
import { WelcomeEmailService } from './welcome-email.service';
import { WelcomeEmailModule } from './welcome-email.module';

describe('account welcome channels', () => {
  it('resolves the actual module graph without starting workers or a database', async () => {
    const module = await Test.createTestingModule({ imports: [WelcomeEmailModule] })
      .overrideProvider(PrismaService).useValue({})
      .overrideProvider(ConfigService).useValue({ get: (key: string) => key === 'JWT_SECRET_KEY' ? 'test-only-secret' : undefined })
      .compile();
    expect(module.get(AccountWelcomeService)).toBeInstanceOf(AccountWelcomeService);
    expect(module.get(WelcomeEmailService)).toBeInstanceOf(WelcomeEmailService);
    expect(module.get(WelcomeSmsService)).toBeInstanceOf(WelcomeSmsService);
    expect(module.get(NotificationSmsService)).toBeInstanceOf(NotificationSmsService);
    await module.close();
  });

  it('still checks SMS eligibility when the new account has no welcome email', async () => {
    const db = {};
    const email = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const sms = { enqueue: jest.fn().mockResolvedValue(undefined) };
    await new AccountWelcomeService(email as never, sms as never).enqueue(7, db as never);
    expect(email.enqueue).toHaveBeenCalledWith(7, db);
    expect(sms.enqueue).toHaveBeenCalledWith(7, db);
  });
});
