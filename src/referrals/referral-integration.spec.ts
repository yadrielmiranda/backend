import { Prisma, PaymentType } from '@prisma/client';
import { PaymentsService } from '@/payments/payments.service';
import { presentApiResponse } from '@/common/response-privacy.interceptor';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import { ReferralsController } from './referrals.module';

describe('Referral order creation and response privacy', () => {
  it('creates frozen rewards inside the new client order flow and does not duplicate them on reconciliation', async () => {
    const profile = { id: 5, userId: 2, enabled: true, useRoleDefaults: false, mode: 'CUSTOM_PERCENT', percent: new Prisma.Decimal(25), revision: 1,
      user: { id: 2, parentDealerId: null, isActive: true, networkSuspended: false, deletedAt: null,
        role: { name: 'client', markup: new Prisma.Decimal('0.4') } } };
    const estimate: any = { id: 9, idUser: 8, units: 1, number: 'TEST-9', status: { name: 'Active' }, order: null,
      installationJob: null, user: { role: { name: 'client' } }, dealerModeSnapshot: null,
      priceT: new Prisma.Decimal(140), customerPriceT: new Prisma.Decimal(140), rateT: new Prisma.Decimal(100) };
    const payment = { id: 11, idEst: 9, type: PaymentType.MATERIAL, baseAmount: new Prisma.Decimal(140), estimate };
    const db: any = {
      estimateStatus: { findUnique: jest.fn(async () => ({ id: 2, name: 'Ordered' })) },
      orderStatus: { findUnique: jest.fn(async () => ({ id: 1, name: 'Pending' })) },
      orderSequence: { create: jest.fn(async () => ({ id: 1 })) },
      order: { create: jest.fn(async ({ data }) => ({ id: 4, ...data })) },
      estimate: { update: jest.fn() }, eventLog: { create: jest.fn() },
      referralAttribution: { findUnique: jest.fn(async () => ({ id: 3, profileId: 5,
        referredUser: { role: { name: 'client' } }, profile })) },
      referralReward: { create: jest.fn() },
    };
    const service = new PaymentsService({} as any, { get: () => 'sk_test_referrals_offline' } as any,
      {} as any, { createAndSend: jest.fn() } as any);
    expect(await (service as any).ensureOrderForInitialPayment(db, payment)).toBe(true);
    expect(db.order.create).toHaveBeenCalledTimes(1);
    expect(db.referralReward.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      orderId: 4, profileId: 5, attributionId: 3, terms: expect.objectContaining({ percent: '25', profileRevision: 1 }),
    }) });
    estimate.order = { id: 4, paymentId: payment.id };
    estimate.status.name = 'Ordered';
    expect(await (service as any).ensureOrderForInitialPayment(db, payment)).toBe(false);
    expect(db.referralReward.create).toHaveBeenCalledTimes(1);
  });

  it('never serializes banking ciphertext or raw referral terms, even to staff', () => {
    for (const name of ['admin', 'operator', 'dealer', 'client'] as const) {
      const result = presentApiResponse({
        encryptedDetails: 'sensitive-bank-envelope', encryptedDestination: 'sensitive-payout-envelope',
        order: { id: 4, referralReward: { terms: { dealerMarkup: '0.1', earningsPlan: { percent: '50' } } } },
        referralCosts: { amount: '30.00', status: 'CALCULATED' },
      }, { id: 8, role: { name } });
      expect(result).not.toHaveProperty('encryptedDetails');
      expect(result).not.toHaveProperty('encryptedDestination');
      expect(result.order).not.toHaveProperty('referralReward');
      if (['client', 'dealer'].includes(name)) expect(result).not.toHaveProperty('referralCosts');
      else expect(result.referralCosts.amount).toBe('30.00');
    }
  });

  it('keeps referral settings exclusive to the admin across nested and list responses', () => {
    const terms = { mode: 'CUSTOM_PERCENT', percent: '10', useRoleDefaults: false };
    const payload = {
      profile: { enabled: true, code: 'a'.repeat(36), linkCreatedAt: null },
      roleDefaults: [{ role: 'CLIENT', ...terms }],
      accounts: [{ id: 2, referralProfile: terms, referralTerms: terms, referralRoleDefaults: [terms] }],
      balances: { available: '30.00' },
    };
    for (const name of ['operator', 'dealer', 'client', 'technician', undefined]) {
      const viewer = name ? { id: 8, role: { name } } : undefined;
      const result = presentApiResponse(payload, viewer as any);
      expect(result).not.toHaveProperty('roleDefaults');
      expect(result.accounts).toEqual([{ id: 2 }]);
      expect(result.profile).toEqual(payload.profile);
      expect(result.balances.available).toBe('30.00');
    }
    const adminResult = presentApiResponse(payload, { id: 1, role: { name: 'admin' } });
    expect(adminResult.roleDefaults).toEqual(payload.roleDefaults);
    expect(adminResult.accounts[0].referralProfile).toEqual(terms);
  });

  it('only permits administrators to view or change role defaults and individual exceptions', () => {
    const guard = new RolesGuard(new Reflector());
    for (const handler of [ReferralsController.prototype.list, ReferralsController.prototype.listUsers,
      ReferralsController.prototype.listRoleDefaults, ReferralsController.prototype.roleDefaults,
      ReferralsController.prototype.saveProfile]) {
      for (const name of ['admin', 'operator', 'dealer', 'client', 'technician', undefined]) {
        const context: any = {
          getHandler: () => handler, getClass: () => ReferralsController,
          switchToHttp: () => ({ getRequest: () => ({ user: name ? { id: 1, role: { name } } : undefined }) }),
        };
        expect(guard.canActivate(context)).toBe(name === 'admin');
      }
    }
  });
});
