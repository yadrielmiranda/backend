import { ValidationPipe } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterUserDto } from './dto/register-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

const personal = { username: 'review-user', firstName: 'Test', lastName: 'User',
  email: 'review@example.test', phone: '+13055550111', street: '123 Example St',
  city: 'Miami', state: 'FL', postalCode: '33101' };
const restricted = { idRole: 1, dealerMode: 'INTERNAL', noInstallationDeposit: true,
  dealerEarningsPlanId: 1, dealerEarningsPlan: { connect: { id: 1 } },
  paymentPlanId: 1, installationPriceProfileId: 1, markupOverride: '-0.99',
  isTaxExempt: true, isActive: false, password: 'Unexpected-change',
  passwordUpdatedAt: new Date(), role: { connect: { id: 1 } } };

describe('Self-service field authorization (H01)', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true,
    transformOptions: { enableImplicitConversion: true } });

  it('preserves personal fields and strips every commercial/access field from the profile DTO', async () => {
    const result = await pipe.transform({ ...personal, ...restricted }, { type: 'body', metatype: UpdateProfileDto });
    expect(result).toEqual(personal);
  });

  it('does not let direct profile service calls bypass the whitelist', async () => {
    const users = { updateUser: jest.fn(async (args) => args.data) };
    const service = new AuthService(users as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    expect(await service.updateProfile(7, { ...personal, ...restricted } as any)).toEqual(personal);
    expect(users.updateUser).toHaveBeenCalledWith({ where: { id: 7 }, data: personal });
  });

  it('allows partial updates without resetting omitted fields', async () => {
    const users = { updateUser: jest.fn(async (args) => args.data) };
    const service = new AuthService(users as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    expect(await service.updateProfile(7, { firstName: 'Updated' })).toEqual({ firstName: 'Updated' });
  });

  it('registration keeps only personal data, the initial password and SMS consent fields', async () => {
    const result = await pipe.transform({ ...personal, ...restricted, password: 'Example-password-123',
      serviceConsent: false, promotionsConsent: false }, { type: 'body', metatype: RegisterUserDto });
    expect(result).toEqual({ ...personal, password: 'Example-password-123', serviceConsent: false, promotionsConsent: false });
  });

  it('the registration service forces client defaults even if called without the validation pipe', async () => {
    const db: any = { role: { findUnique: jest.fn(async () => ({ id: 4 })) },
      user: { create: jest.fn(async ({ data }) => ({ id: 7, ...data })) },
      registrationConsent: { create: jest.fn() }, smsConsent: { create: jest.fn() }, smsConsentEvent: { create: jest.fn() } };
    db.$transaction = work => work(db);
    db.$queryRaw = jest.fn(async () => [{ id: 1 }]);
    db.platformTermsState = { findUniqueOrThrow: jest.fn(async () => ({ currentVersion: null })) };
    const service = new AuthService({} as any, db, {} as any, {} as any, {} as any,
      { getProgram: async () => ({ version: 'a'.repeat(64) }) } as any,
      { checkAddress: async () => ({ available: true }) } as any);
    await service.registerUser({ ...personal, ...restricted, password: 'Example-password-123',
      serviceConsent: false, promotionsConsent: false } as any);
    const saved = db.user.create.mock.calls[0][0].data;
    expect(saved).toMatchObject({ ...personal, isTaxExempt: false, role: { connect: { id: 4 } } });
    expect(saved.password).not.toBe('Example-password-123');
    for (const key of ['dealerEarningsPlanId', 'dealerEarningsPlan', 'markupOverride', 'installationPriceProfileId', 'paymentPlanId', 'dealerMode', 'noInstallationDeposit', 'isActive', 'idRole']) {
      expect(saved).not.toHaveProperty(key);
    }
  });
});
