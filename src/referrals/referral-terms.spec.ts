import { Prisma, ReferralRewardMode } from '@prisma/client';
import { allowedReferralModes, effectiveReferralProfile, referralRole, referralTerms, resolveRegistrationReferral, snapshotReferralReward } from './referral-terms';
import { AuthService } from '@/auth/auth.service';

const dec = (value: string) => new Prisma.Decimal(value);
function profile(overrides: Record<string, unknown> = {}) {
  return { id: 10, userId: 3, code: 'a'.repeat(36), enabled: true, linkCreatedAt: new Date(),
    useRoleDefaults: false, mode: ReferralRewardMode.CUSTOM_PERCENT, percent: dec('25'), revision: 2,
    user: { id: 3, role: { name: 'client', markup: dec('0.4') }, parentDealerId: null,
      isActive: true, deletedAt: null, networkSuspended: false, markupOverride: null,
      dealerMode: null, dealerEarningsPlan: null }, ...overrides } as any;
}
function dbFixture(saved = profile()) {
  return {
    referralProfile: { findUnique: jest.fn(async () => saved) },
    referralAttribution: { findUnique: jest.fn(async () => ({ id: 5, profileId: 10, profile: saved,
      referredUser: { role: { name: 'client' } } })) },
    referralReward: { create: jest.fn() }, user: { findUnique: jest.fn() },
    referralRoleDefault: { findMany: jest.fn(async () => [{ role: 'CLIENT', mode: 'CUSTOM_PERCENT', percent: dec('10'), revision: 3 }]) },
  };
}

describe('Referral attribution and frozen conditions', () => {
  it('distinguishes root dealers from subdealers/distributors and other roles', () => {
    expect(allowedReferralModes({ role: { name: 'dealer' }, parentDealerId: null, dealerMode: 'EXTERNAL' })).toEqual(['EXTERNAL_MARGIN']);
    expect(allowedReferralModes({ role: { name: 'dealer' }, parentDealerId: null, dealerMode: 'INTERNAL' })).toEqual(['CUSTOM_PERCENT', 'DEALER_PLAN']);
    for (const dealerMode of ['INTERNAL', 'EXTERNAL'])
      expect(allowedReferralModes({ role: { name: 'dealer' }, parentDealerId: 1, dealerMode })).toEqual(['CUSTOM_PERCENT']);
    expect(allowedReferralModes({ role: { name: 'client' } })).toEqual(['CUSTOM_PERCENT']);
    for (const name of ['admin', 'operator', 'technician']) expect(allowedReferralModes({ role: { name } })).toEqual([]);
  });

  it('freezes only one rule and preserves fractional dealer markup', () => {
    const p = profile();
    expect(referralTerms(p)).toMatchObject({ mode: 'CUSTOM_PERCENT', percent: '25', profileRevision: 2 });
    p.mode = 'EXTERNAL_MARGIN'; p.user.role.name = 'dealer'; p.user.dealerMode = 'EXTERNAL';
    p.user.markupOverride = dec('0.10');
    const terms = referralTerms(p)!;
    expect(terms).toMatchObject({ dealerMarkup: '0.1', dealerPriceBasis: 'SAVED_UNIT_APP_BASE' });
    expect(terms).not.toHaveProperty('percent');
    p.user.markupOverride = dec('0.15');
    expect(terms).toMatchObject({ dealerMarkup: '0.1' });
  });

  it('snapshots the assigned internal plan without combining it with a custom percentage', () => {
    const p = profile({ mode: 'DEALER_PLAN' });
    Object.assign(p.user, { role: { name: 'dealer', markup: dec('0.1') }, dealerMode: 'INTERNAL',
      dealerEarningsPlan: { id: 6, name: 'Real profit', revision: 4, basis: 'REAL_PROFIT', percent: dec('30'), isActive: true } });
    const terms = referralTerms(p)!;
    expect(terms).toMatchObject({ earningsPlan: { planId: 6, revision: 4, basis: 'REAL_PROFIT', percent: '30' } });
    expect(terms).not.toHaveProperty('percent');
    p.user.dealerEarningsPlan.isActive = false;
    expect(referralTerms(p)).toMatchObject({ earningsPlan: null, configurationIssue: 'MISSING_DEALER_PLAN' });
  });

  it('requires configured percentages and a rule matching the actual current account level', () => {
    expect(referralTerms(profile({ percent: null }))).toBeNull();
    expect(referralTerms(profile({ percent: dec('101') }))).toBeNull();
    expect(referralTerms(profile({ percent: dec('0') }))).not.toBeNull();
    expect(referralTerms(profile({ mode: 'EXTERNAL_MARGIN' }))).toBeNull();
  });

  it('does not query referral data for normal registration', async () => {
    const db = dbFixture();
    expect(await resolveRegistrationReferral(db as any)).toBeNull();
    expect(db.referralProfile.findUnique).not.toHaveBeenCalled();
  });

  it('only resolves a created, enabled link from an eligible account', async () => {
    const p = profile(), db = dbFixture(p);
    expect(await resolveRegistrationReferral(db as any, p.code)).toBe(p);
    for (const changes of [{ enabled: false }, { linkCreatedAt: null }]) {
      db.referralProfile.findUnique.mockResolvedValueOnce({ ...p, ...changes });
      await expect(resolveRegistrationReferral(db as any, p.code)).rejects.toThrow('unavailable');
    }
    for (const changes of [{ isActive: false }, { deletedAt: new Date() }, { networkSuspended: true }]) {
      db.referralProfile.findUnique.mockResolvedValueOnce({ ...p, user: { ...p.user, ...changes } });
      await expect(resolveRegistrationReferral(db as any, p.code)).rejects.toThrow('unavailable');
    }
    await expect(resolveRegistrationReferral(db as any, '../unsafe')).rejects.toThrow('unavailable');
  });

  it('resolves all six categories using account role, own mode and persisted ancestry', () => {
    const dealer = { role: { name: 'dealer' }, parentDealerId: null, dealerMode: 'EXTERNAL' };
    expect(referralRole({ role: { name: 'client' } })).toBe('CLIENT');
    expect(referralRole(dealer)).toBe('DEALER_EXTERNAL');
    expect(referralRole({ ...dealer, dealerMode: 'INTERNAL' })).toBe('DEALER_INTERNAL');
    expect(referralRole({ ...dealer, parentDealerId: 1, parentDealer: { parentDealerId: null } })).toBe('SUBDEALER_EXTERNAL');
    expect(referralRole({ ...dealer, parentDealerId: 1, dealerMode: 'INTERNAL', parentDealer: { parentDealerId: null } })).toBe('SUBDEALER_INTERNAL');
    expect(referralRole({ ...dealer, parentDealerId: 2, parentDealer: { parentDealerId: 1 } })).toBe('DISTRIBUTOR');
  });

  it('inherits role changes for new orders, preserves individual exceptions, and resets to the latest default', async () => {
    const p = profile({ useRoleDefaults: true }), db = dbFixture(p);
    await snapshotReferralReward(db as any, 21, 9);
    const original = db.referralReward.create.mock.calls[0][0].data.terms;
    expect(original).toMatchObject({ percent: '10', source: 'ROLE_DEFAULT', roleRevision: 3 });
    db.referralRoleDefault.findMany.mockResolvedValue([{ role: 'CLIENT', mode: 'CUSTOM_PERCENT', percent: dec('12'), revision: 4 }]);
    await snapshotReferralReward(db as any, 22, 9);
    expect(db.referralReward.create.mock.calls[1][0].data.terms).toMatchObject({ percent: '12', roleRevision: 4 });
    expect(original).toMatchObject({ percent: '10', roleRevision: 3 });
    p.useRoleDefaults = false; p.percent = dec('15');
    await snapshotReferralReward(db as any, 23, 9);
    expect(db.referralReward.create.mock.calls[2][0].data.terms).toMatchObject({ percent: '15', source: 'INDIVIDUAL' });
    p.useRoleDefaults = true;
    await snapshotReferralReward(db as any, 24, 9);
    expect(db.referralReward.create.mock.calls[3][0].data.terms).toMatchObject({ percent: '12', source: 'ROLE_DEFAULT' });
  });

  it('keeps inherited links available at zero percent and without a bank or active dealer plan', async () => {
    const p = profile({ useRoleDefaults: true, percent: null }), db = dbFixture(p);
    expect(await resolveRegistrationReferral(db as any, p.code)).toBe(p);
    Object.assign(p.user, { role: { name: 'dealer', markup: dec('0.1') }, dealerMode: 'INTERNAL' });
    db.referralRoleDefault.findMany.mockResolvedValue([{ role: 'DEALER_INTERNAL', mode: 'DEALER_PLAN', percent: null, revision: 1 } as any]);
    expect(await resolveRegistrationReferral(db as any, p.code)).toBe(p);
    await snapshotReferralReward(db as any, 21, 9);
    expect(db.referralReward.create).toHaveBeenCalledWith({ data: expect.objectContaining({ reason: 'PENDING_REVIEW',
      terms: expect.objectContaining({ earningsPlan: null, configurationIssue: 'MISSING_DEALER_PLAN' }) }) });
  });

  it('replaces an incompatible exception with the current role default after a category change', () => {
    const p = profile({ useRoleDefaults: false });
    p.user.role.name = 'dealer'; p.user.dealerMode = 'EXTERNAL';
    expect(effectiveReferralProfile(p, p.user, [])).toMatchObject({ useRoleDefaults: true, mode: 'EXTERNAL_MARGIN', percent: null });
    p.enabled = false;
    expect(effectiveReferralProfile(p, p.user, [])).toMatchObject({ useRoleDefaults: false, enabled: false, mode: 'EXTERNAL_MARGIN' });
  });

  it('records only the direct referrer for each new order, never walking referral ancestry', async () => {
    const db = dbFixture();
    await snapshotReferralReward(db as any, 21, 9);
    expect(db.referralAttribution.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { referredUserId: 9 } }));
    expect(db.referralReward.create).toHaveBeenCalledTimes(1);
    expect(db.referralReward.create).toHaveBeenCalledWith({ data: expect.objectContaining({ orderId: 21, profileId: 10, attributionId: 5,
      terms: expect.objectContaining({ percent: '25', profileRevision: 2 }) }) });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('does not create rewards for self attribution, non-client orders, or disabled referrers', async () => {
    const p = profile(), db = dbFixture(p);
    await snapshotReferralReward(db as any, 21, 3);
    p.enabled = false;
    await snapshotReferralReward(db as any, 22, 9);
    p.enabled = true;
    db.referralAttribution.findUnique.mockResolvedValueOnce({ id: 5, profileId: 10, profile: p, referredUser: { role: { name: 'dealer' } } });
    await snapshotReferralReward(db as any, 23, 9);
    expect(db.referralReward.create).not.toHaveBeenCalled();
  });
});

describe('Referral registration integration', () => {
  function fixture() {
    const db: any = dbFixture();
    db.role = { findUnique: jest.fn(async () => ({ id: 4 })) };
    db.user.create = jest.fn(async ({ data }) => ({ id: 9, ...data }));
    db.referralAttribution.create = jest.fn();
    db.registrationConsent = { create: jest.fn() };
    db.smsConsent = { create: jest.fn() };
    db.smsConsentEvent = { create: jest.fn() };
    db.$queryRaw = jest.fn(async () => [{ id: 1 }]);
    db.platformTermsState = { findUniqueOrThrow: jest.fn(async () => ({ currentVersion: null })) };
    db.$transaction = jest.fn(async work => work(db));
    const auth = new AuthService({} as any, db, {} as any, {} as any, {} as any,
      { getProgram: async () => ({ version: 'a'.repeat(64) }) } as any,
      { checkAddress: async () => ({ available: true }) } as any);
    const data = { username: 'new-client', firstName: 'Test', lastName: 'Client', phone: '+13055550111',
      email: 'new-client@example.test', password: 'Example-password-123',
      street: '123 Example St', city: 'Miami', state: 'FL', postalCode: '33101',
      referralCode: 'a'.repeat(36), serviceConsent: false, promotionsConsent: false };
    return { db, auth, data };
  }

  it('atomically creates a client with attribution without assigning dealer ancestry or accepting commercial fields', async () => {
    const { db, auth, data } = fixture();
    await auth.registerUser({ ...data, parentDealerId: 3, markupOverride: 0, idRole: 1 } as any);
    expect(db.user.create.mock.calls[0][0].data).toMatchObject({ role: { connect: { id: 4 } }, isTaxExempt: false });
    expect(db.user.create.mock.calls[0][0].data).not.toHaveProperty('parentDealerId');
    expect(db.user.create.mock.calls[0][0].data).not.toHaveProperty('referralCode');
    expect(db.referralAttribution.create).toHaveBeenCalledWith({ data: { profileId: 10, referredUserId: 9 } });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects an unavailable referral before saving the new account', async () => {
    const { db, auth, data } = fixture();
    db.referralProfile.findUnique.mockResolvedValueOnce(null);
    await expect(auth.registerUser(data as any)).rejects.toThrow('unavailable');
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.referralAttribution.create).not.toHaveBeenCalled();
  });
});
