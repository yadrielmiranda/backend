import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { ReferralBankCipher, validateReferralBank } from './referral-bank';
import { ReferralsService, referralBalances, referralMoney, referralSummary } from './referrals.service';
import { ReferralsController } from './referrals.module';
import { ROLES_KEY } from '@/auth/roles.decorator';
import { calculateReferralReward } from './referral-rewards';

jest.mock('./referral-rewards', () => ({ referralRewardEstimateInclude: {}, calculateReferralReward: jest.fn() }));

const requestKey = '39a36be3-e2cb-4eba-876a-40f4f664cfed';
const otherKey = '57aad73d-89ef-4cbf-9046-c861384b9b41';

function fixture() {
  const owner = { id: 7, firstName: 'Test', lastName: 'Owner', role: { name: 'client' }, isActive: true, deletedAt: null, parentDealerId: null };
  const profile: any = { id: 3, userId: owner.id, code: 'a'.repeat(36), mode: 'CUSTOM_PERCENT', percent: new Decimal(20), enabled: true,
    revision: 1, useRoleDefaults: true, linkCreatedAt: null };
  const roleDefaults: any[] = [{ role: 'CLIENT', mode: 'CUSTOM_PERCENT', percent: new Decimal(10), revision: 1 }];
  const payouts: any[] = [];
  const cipher = new ReferralBankCipher(new ConfigService({ REFERRAL_BANK_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64') }));
  const bankInput = { holderName: 'Test Owner', holderType: 'PERSONAL', bankName: 'Example Bank', accountType: 'CHECKING',
    routingNumber: '021000021', accountNumber: '000123456', confirmAccountNumber: '000123456', authorized: true };
  const bank = { profileId: 3, bankName: bankInput.bankName, accountLast4: '3456', encryptedDetails: cipher.encrypt(validateReferralBank(bankInput), 'profile:3') };
  let funds = '200.00';
  const db: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    user: { findUnique: jest.fn(async ({ where }) => [1, 2].includes(where.id) ? { id: where.id, role: { name: 'admin' }, isActive: true } : owner) },
    referralProfile: { upsert: jest.fn(async () => profile), findUnique: jest.fn(async () => profile),
      update: jest.fn(async ({ data }) => { const revision = profile.revision + (data.revision?.increment ?? 0); Object.assign(profile, data, { revision }); return profile; }) },
    referralRoleDefault: { findMany: jest.fn(async () => roleDefaults),
      findUnique: jest.fn(async ({ where }) => ({ ...roleDefaults.find(row => row.role === where.role) })),
      upsert: jest.fn(async ({ where, create }) => { const existing = roleDefaults.find(row => row.role === where.role); if (existing) return existing; roleDefaults.push(create); return create; }),
      update: jest.fn(async ({ where, data }) => { const row = roleDefaults.find(row => row.role === where.role); const revision = row.revision + data.revision.increment; Object.assign(row, data, { revision }); return row; }) },
    referralReward: { findMany: jest.fn(async () => []), aggregate: jest.fn(async () => ({ _sum: { earnedAmount: new Decimal(funds), availableAmount: new Decimal(funds) } })) },
    referralSettings: { findUnique: jest.fn(async () => ({ minimumWithdrawal: new Decimal(0) })) },
    referralBankAccount: { findUnique: jest.fn(async () => bank) },
    referralPayout: {
      findUnique: jest.fn(async ({ where }) => payouts.find(p => where.id != null ? p.id === where.id : p.requestKey === where.requestKey) ?? null),
      aggregate: jest.fn(async ({ where }) => ({ _sum: { amount: payouts.filter(p => p.profileId === where.profileId &&
        (typeof where.status === 'string' ? p.status === where.status : where.status.in.includes(p.status)))
        .reduce((sum, p) => sum.add(p.amount), new Decimal(0)) } })),
      create: jest.fn(async ({ data }) => {
        const row = { ...data, id: payouts.length + 1, createdAt: new Date(Date.now() - 10000), status: 'REQUESTED', amount: new Decimal(data.amount), bankFee: new Decimal(0) };
        payouts.push(row); return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = payouts.find(p => p.id === where.id);
        Object.assign(row, data); return row;
      }),
    },
    eventLog: { create: jest.fn(async () => ({})) },
  };
  // Model transactions serializing at the database locks. Tests also inspect lock SQL.
  let queue = Promise.resolve();
  db.$transaction = (fn: any) => { const task = queue.then(() => fn(db)); queue = task.catch(() => undefined); return task; };
  const service = new ReferralsService(db, cipher);
  return { service, db, owner, profile, roleDefaults, payouts, bank, cipher, bankInput, setFunds: (value: string) => { funds = value; } };
}

describe('referral withdrawal accounting', () => {
  it('lets a new eligible owner generate a link without bank or individual setup and only returns public fields', async () => {
    const f = fixture();
    f.profile.percent = null;
    const result = await f.service.createLink(7);
    expect(result).toEqual({ enabled: true, code: f.profile.code, linkCreatedAt: expect.any(Date) });
    expect(f.db.referralProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ enabled: true, useRoleDefaults: true }) }));
    expect(f.db.referralBankAccount.findUnique).not.toHaveBeenCalled();
    f.profile.enabled = false; f.profile.useRoleDefaults = false;
    await expect(f.service.createLink(7)).rejects.toThrow('unavailable');
  });

  it('keeps calculation settings out of the dashboard and generalizes pending-cost status', async () => {
    const f = fixture();
    f.db.referralAttribution = { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) };
    f.db.referralReward.count = jest.fn(async () => 1);
    f.db.referralReward.findMany.mockImplementation(async ({ select }) => select ? [] : [{ id: 10, createdAt: new Date(), reason: 'PENDING_REAL_COST', earnedAmount: new Decimal(20), terms: { percent: '20' }, attribution: { referredUser: { firstName: 'Client' } } }]);
    f.db.referralPayout.findMany = jest.fn(async () => []); f.db.referralPayout.count = jest.fn(async () => 0);
    const result = await f.service.dashboard(7);
    expect(Object.keys(result.profile).sort()).toEqual(['code', 'enabled', 'linkCreatedAt']);
    expect(result.rewards[0]).toMatchObject({ status: 'PENDING_REVIEW', reason: 'PENDING_REVIEW' });
    expect(result.rewards[0]).not.toHaveProperty('terms');
  });

  it('validates a public referral code without returning or separately querying the referrer name', async () => {
    const f = fixture();
    Object.assign(f.profile, { user: f.owner, linkCreatedAt: new Date() });
    expect(await f.service.resolve(f.profile.code)).toEqual({ valid: true, code: f.profile.code });
    expect(f.db.user.findUnique).not.toHaveBeenCalled();
    f.profile.useRoleDefaults = false; f.profile.enabled = false;
    await expect(f.service.resolve(f.profile.code)).rejects.toThrow(BadRequestException);
    await expect(f.service.resolve('invalid')).rejects.toThrow(BadRequestException);
  });

  it('audits role defaults separately, preserves an exception, and resets it to current role settings', async () => {
    const f = fixture();
    const custom = await f.service.saveProfile(1, 7, { useRoleDefaults: false, enabled: true, mode: 'CUSTOM_PERCENT', percent: '15' });
    expect(custom).toMatchObject({ useRoleDefaults: false, percent: '15' });
    const role = await f.service.saveRoleDefault(1, 'CLIENT', { mode: 'CUSTOM_PERCENT', percent: '12' });
    expect(role).toMatchObject({ percent: '12', revision: 2 });
    expect(f.profile.percent).toBe('15');
    const inherited = await f.service.saveProfile(1, 7, { useRoleDefaults: true });
    expect(inherited).toMatchObject({ enabled: true, useRoleDefaults: true, percent: '12' });
    expect(f.db.eventLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ entityType: 'ReferralRoleDefault',
      tempLog: expect.objectContaining({ create: expect.objectContaining({ before: expect.objectContaining({ percent: '10' }), after: expect.objectContaining({ percent: '12' }) }) }) }) }));
  });

  it('rejects invalid role modes, unknown roles, invalid percentages and non-admin default changes', async () => {
    const f = fixture();
    await expect(f.service.saveRoleDefault(1, 'DEALER_EXTERNAL', { mode: 'CUSTOM_PERCENT', percent: '10' })).rejects.toThrow(BadRequestException);
    await expect(f.service.saveRoleDefault(1, 'CLIENT', { mode: 'CUSTOM_PERCENT', percent: '101' })).rejects.toThrow(BadRequestException);
    await expect(f.service.saveRoleDefault(1, 'admin', { mode: 'CUSTOM_PERCENT', percent: '10' })).rejects.toThrow(BadRequestException);
    await expect(f.service.saveRoleDefault(7, 'CLIENT', { mode: 'CUSTOM_PERCENT', percent: '10' })).rejects.toThrow(ForbiddenException);
  });

  it('keeps an intentionally disabled account disabled when saving compatible settings after a role change', async () => {
    const f = fixture();
    Object.assign(f.owner, { role: { name: 'dealer' }, dealerMode: 'EXTERNAL' });
    f.profile.useRoleDefaults = false; f.profile.enabled = false;
    const result = await f.service.saveProfile(1, 7, { useRoleDefaults: false, enabled: false, mode: 'EXTERNAL_MARGIN' });
    expect(result).toMatchObject({ useRoleDefaults: false, enabled: false, mode: 'EXTERNAL_MARGIN' });
    await expect(f.service.createLink(7)).rejects.toThrow('unavailable');
  });

  it('lists automatic defaults for accounts without profiles and flags missing internal dealer plans privately', async () => {
    const f = fixture();
    f.db.user.findMany = jest.fn(async () => [
      { ...f.owner, referralProfile: null },
      { ...f.owner, id: 9, role: { name: 'dealer' }, dealerMode: 'INTERNAL', referralProfile: null, dealerEarningsPlan: null },
    ]);
    f.roleDefaults.push({ role: 'DEALER_INTERNAL', mode: 'DEALER_PLAN', percent: null, revision: 2 });
    f.db.user.count = jest.fn(async () => 2);
    f.db.referralPayout.findMany = jest.fn(async () => []); f.db.referralPayout.count = jest.fn(async () => 0);
    f.db.referralReward.groupBy = jest.fn(async () => []); f.db.referralPayout.groupBy = jest.fn(async () => []);
    const result = await f.service.listAdminUsers(1);
    expect(result.roleDefaults).toHaveLength(6);
    expect(result.users[0]).toMatchObject({ referralRole: 'CLIENT', useRoleDefaults: true, profile: { enabled: true, percent: '10' } });
    expect(result.users[1]).toMatchObject({ referralRole: 'DEALER_INTERNAL', useRoleDefaults: true, configurationIssue: 'MISSING_DEALER_PLAN' });
    expect(f.db.referralProfile.upsert).not.toHaveBeenCalled();
  });

  it('rejects invalid precision, signs, exponent notation, numeric coercion and zero withdrawals', () => {
    for (const value of ['-1', '1.001', '1e2', '0', '10000000000000000', 10, NaN, undefined])
      expect(() => referralMoney(value)).toThrow(BadRequestException);
    expect(referralMoney('0', true).toFixed(2)).toBe('0.00');
    expect(referralMoney('12.50').toFixed(2)).toBe('12.50');
  });

  it('accounts for reservations and paid withdrawals and holds reversals as debt', () => {
    expect(referralBalances('300', '200', '50', '100')).toEqual({ pending: '100.00', available: '50.00', reserved: '50.00', paid: '100.00', adjustmentDebt: '0.00' });
    expect(referralBalances('20', '20', '10', '100')).toMatchObject({ available: '0.00', adjustmentDebt: '90.00' });
  });

  it('keeps one account correction separate from another account available earnings in the admin summary', () => {
    expect(referralSummary([
      { profileId: 1, earnedAmount: '0', availableAmount: '0' }, { profileId: 2, earnedAmount: '200', availableAmount: '200' },
    ], [{ profileId: 1, status: 'PAID', amount: '100', bankFee: '2.50' }])).toMatchObject({
      earned: '200.00', available: '200.00', paid: '100.00', adjustmentDebt: '100.00', bankFees: '2.50',
    });
  });

  it('reserves a withdrawal exactly once and freezes its destination without exposing it', async () => {
    const f = fixture();
    const first = await f.service.requestPayout(7, { amount: '120', requestKey });
    expect(first).toMatchObject({ amount: '120', status: 'REQUESTED', bankName: 'Example Bank', accountLast4: '3456' });
    expect(JSON.stringify(first)).not.toContain('000123456');
    expect(first).not.toHaveProperty('encryptedDestination');
    const saved = f.payouts[0];
    expect(f.cipher.decrypt(saved.encryptedDestination, `payout:3:${requestKey}`).accountNumber).toBe('000123456');
    await f.service.requestPayout(7, { amount: '120.00', requestKey });
    expect(f.db.referralPayout.create).toHaveBeenCalledTimes(1);
    await expect(f.service.requestPayout(7, { amount: '121', requestKey })).rejects.toThrow(ConflictException);
    const lockSql = f.db.$queryRaw.mock.calls.map(args => args[0].join('?')).join('\n');
    expect(lockSql).toContain('ReferralProfile WHERE id = ? FOR UPDATE');
  });

  it('prevents two concurrent withdrawal requests from spending the same earnings', async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.service.requestPayout(7, { amount: '150', requestKey }),
      f.service.requestPayout(7, { amount: '100', requestKey: otherKey }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(f.payouts).toHaveLength(1);
  });

  it('refreshes earned amounts once, reverses availability for a refund review, and restores it with append-only deltas', async () => {
    const f = fixture();
    const reward: any = { id: 5, terms: {}, earnedAmount: new Decimal(0), availableAmount: new Decimal(0), reason: 'PENDING_PAYMENT' };
    f.db.referralReward.findMany.mockImplementation(async ({ select }) => select
      ? [{ id: 5, order: { idEst: 20 } }, { id: 6, order: { idEst: 10 } }]
      : [reward]);
    f.db.estimate = { findMany: jest.fn(async () => [{ id: 20 }]) };
    f.db.referralReward.update = jest.fn(async ({ data }) => {
      Object.assign(reward, data, { earnedAmount: new Decimal(data.earnedAmount), availableAmount: new Decimal(data.availableAmount) });
      return reward;
    });
    f.db.referralReward.updateMany = jest.fn(async () => ({ count: 1 }));
    f.db.referralReward.aggregate.mockImplementation(async () => ({ _sum: { earnedAmount: reward.earnedAmount, availableAmount: reward.availableAmount } }));
    f.db.referralLedgerEntry = { create: jest.fn(async ({ data }) => data) };
    const calculate = calculateReferralReward as jest.Mock;
    calculate.mockReturnValue({ earnedAmount: '200.00', availableAmount: '200.00', reason: 'AVAILABLE' });
    await f.service.requestPayout(7, { amount: '100', requestKey });
    await f.service.requestPayout(7, { amount: '100', requestKey });
    expect(f.db.referralLedgerEntry.create).toHaveBeenCalledTimes(1);
    expect(f.db.referralReward.updateMany).toHaveBeenCalled();
    const locks = f.db.$queryRaw.mock.calls.slice(0, 3);
    expect(locks.map(args => args[1])).toEqual([10, 20, 3]);
    expect(locks[2][0].join('?')).toContain('ReferralProfile');
    await f.service.transition(1, 1, { status: 'PROCESSING' });
    await f.service.transition(1, 1, { status: 'PAID', reference: 'ACH-test', paidAt: new Date().toISOString() });
    calculate.mockReturnValue({ earnedAmount: '200.00', availableAmount: '0.00', reason: 'PENDING_REVIEW' });
    // Retrying an already-paid request still refreshes its earnings without spending again.
    await f.service.requestPayout(7, { amount: '100', requestKey });
    expect(f.db.referralLedgerEntry.create).toHaveBeenLastCalledWith({ data: {
      rewardId: 5, earnedDelta: '0.00', availableDelta: '-200.00', reason: 'PENDING_REVIEW',
    } });
    expect(referralBalances(reward.earnedAmount, reward.availableAmount, '0', '100')).toMatchObject({ available: '0.00', adjustmentDebt: '100.00' });
    calculate.mockReturnValue({ earnedAmount: '160.00', availableAmount: '160.00', reason: 'AVAILABLE' });
    await f.service.requestPayout(7, { amount: '100', requestKey });
    expect(f.db.referralLedgerEntry.create).toHaveBeenLastCalledWith({ data: {
      rewardId: 5, earnedDelta: '-40.00', availableDelta: '160.00', reason: 'AVAILABLE',
    } });
    expect(f.db.referralLedgerEntry.create).toHaveBeenCalledTimes(3);
    expect(f.payouts).toHaveLength(1);
    expect(referralBalances(reward.earnedAmount, reward.availableAmount, '0', '100')).toMatchObject({ available: '60.00', adjustmentDebt: '0.00' });
  });

  it('does not permit withdrawals above corrected available earnings or below the configured minimum', async () => {
    const f = fixture();
    f.db.referralSettings.findUnique.mockResolvedValue({ minimumWithdrawal: new Decimal(50) });
    await expect(f.service.requestPayout(7, { amount: '49.99', requestKey })).rejects.toThrow('minimum');
    await f.service.requestPayout(7, { amount: '100', requestKey });
    f.setFunds('80');
    await expect(f.service.requestPayout(7, { amount: '50', requestKey: otherKey })).rejects.toThrow('available');
    await expect(f.service.transition(1, 1, { status: 'PROCESSING' })).rejects.toThrow('Available earnings changed');
  });

  it('supports canceling a request and releasing the exact reserved amount', async () => {
    const f = fixture();
    await f.service.requestPayout(7, { amount: '150', requestKey });
    await f.service.cancelPayout(7, 1);
    await f.service.requestPayout(7, { amount: '200', requestKey: otherKey });
    expect(f.payouts.map(p => p.status)).toEqual(['CANCELED', 'REQUESTED']);
  });

  it('cannot access another owner withdrawal or cancel after processing starts', async () => {
    const f = fixture();
    await f.service.requestPayout(7, { amount: '100', requestKey });
    f.payouts[0].profileId = 9;
    await expect(f.service.cancelPayout(7, 1)).rejects.toThrow(NotFoundException);
    f.payouts[0].profileId = 3;
    await f.service.transition(1, 1, { status: 'PROCESSING' });
    await expect(f.service.cancelPayout(7, 1)).rejects.toThrow(BadRequestException);
  });

  it('requires confirmation that funds were not sent before releasing a processing withdrawal', async () => {
    const f = fixture();
    await f.service.requestPayout(7, { amount: '100', requestKey });
    await f.service.transition(1, 1, { status: 'PROCESSING' });
    await expect(f.service.transition(1, 1, { status: 'FAILED', note: 'Bank rejected' })).rejects.toThrow(BadRequestException);
    await expect(f.service.transition(1, 1, { status: 'FAILED', note: 'Bank rejected', confirmedNotSent: 'true' as any })).rejects.toThrow(BadRequestException);
    await f.service.transition(1, 1, { status: 'FAILED', note: 'Bank rejected; no funds sent.', confirmedNotSent: true });
    await f.service.requestPayout(7, { amount: '200', requestKey: otherKey });
    expect(f.payouts[1].amount.toString()).toBe('200');
  });

  it('assigns a processing request to exactly one admin and prevents a second external transfer', async () => {
    const f = fixture();
    await f.service.requestPayout(7, { amount: '100', requestKey });
    const claims = await Promise.allSettled([
      f.service.transition(1, 1, { status: 'PROCESSING' }), f.service.transition(2, 1, { status: 'PROCESSING' }),
    ]);
    expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(f.payouts[0].processingById).toBe(1);
    await expect(f.service.transition(1, 1, { status: 'PROCESSING' })).resolves.toMatchObject({ status: 'PROCESSING' });
    await expect(f.service.revealBank(2, 1)).rejects.toThrow(ConflictException);
    await expect(f.service.transition(2, 1, { status: 'FAILED', confirmedNotSent: true, note: 'Not sent' })).rejects.toThrow(ConflictException);
    await expect(f.service.transition(2, 1, { status: 'PAID', reference: 'Another transfer', paidAt: new Date().toISOString() })).rejects.toThrow(ConflictException);
  });

  it('recovers only a verified bank outcome without granting a second administrator bank access', async () => {
    const f = fixture();
    await f.service.requestPayout(7, { amount: '100', requestKey });
    await f.service.transition(1, 1, { status: 'PROCESSING' });
    const outcome = { status: 'PAID' as const, expectedProcessingById: 1, bankOutcomeConfirmed: true,
      note: 'Verified the bank transfer after original administrator became unavailable.', reference: 'ACH-existing',
      proofReference: 'Bank confirmation record 123', paidAt: new Date().toISOString() };
    await expect(f.service.recover(2, 1, { ...outcome, bankOutcomeConfirmed: false })).rejects.toThrow(BadRequestException);
    await expect(f.service.recover(2, 1, { ...outcome, expectedProcessingById: 99 })).rejects.toThrow(ConflictException);
    await expect(f.service.recover(2, 1, { ...outcome, proofReference: '' })).rejects.toThrow(BadRequestException);
    await expect(f.service.revealBank(2, 1)).rejects.toThrow(ConflictException);
    await f.service.recover(2, 1, outcome);
    expect(f.payouts[0]).toMatchObject({ status: 'PAID', processingById: 1, reference: 'ACH-existing' });
    expect(f.db.eventLog.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 2,
      message: expect.stringContaining('original processing administrator 1') }) }));
    await expect(f.service.recover(2, 1, { ...outcome, status: 'FAILED', confirmedNotSent: true })).rejects.toThrow(BadRequestException);
    await expect(f.service.revealBank(2, 1)).rejects.toThrow(BadRequestException);
  });

  it('releases a recovered failed transfer only after explicit confirmation that nothing was sent or remains pending', async () => {
    const f = fixture();
    await f.service.requestPayout(7, { amount: '100', requestKey });
    await f.service.transition(1, 1, { status: 'PROCESSING' });
    const outcome = { status: 'FAILED' as const, expectedProcessingById: 1, bankOutcomeConfirmed: true, note: 'Bank confirmed no outgoing or pending transfer.' };
    await expect(f.service.recover(2, 1, outcome)).rejects.toThrow(BadRequestException);
    await f.service.recover(2, 1, { ...outcome, confirmedNotSent: true });
    expect(f.payouts[0].status).toBe('FAILED');
    await f.service.requestPayout(7, { amount: '200', requestKey: otherKey });
    expect(f.payouts).toHaveLength(2);
  });

  it('records an actual ACH payment with full amount to the user and a separate company bank fee', async () => {
    const f = fixture();
    await f.service.requestPayout(7, { amount: '100', requestKey });
    await expect(f.service.transition(1, 1, { status: 'PAID', reference: 'ACH-test', paidAt: new Date().toISOString() })).rejects.toThrow(BadRequestException);
    await f.service.transition(1, 1, { status: 'PROCESSING' });
    await expect(f.service.transition(1, 1, { status: 'PAID', paidAt: new Date().toISOString() })).rejects.toThrow(BadRequestException);
    await f.service.transition(1, 1, { status: 'PAID', reference: 'ACH-test', paidAt: new Date().toISOString(), bankFee: '3.50' });
    expect(f.payouts[0]).toMatchObject({ status: 'PAID', bankFee: '3.50', reference: 'ACH-test' });
    expect(f.payouts[0].amount.toString()).toBe('100');
    await expect(f.service.transition(1, 1, { status: 'FAILED', confirmedNotSent: true, note: 'Invalid' })).rejects.toThrow(BadRequestException);
  });

  it('reveals only a processing destination to an administrator and records an audit without bank values', async () => {
    const f = fixture();
    await f.service.requestPayout(7, { amount: '100', requestKey });
    await expect(f.service.revealBank(7, 1)).rejects.toThrow(ForbiddenException);
    await expect(f.service.revealBank(1, 1)).rejects.toThrow(BadRequestException);
    await f.service.transition(1, 1, { status: 'PROCESSING' });
    expect(await f.service.revealBank(1, 1)).toMatchObject({ accountNumber: '000123456' });
    expect(JSON.stringify(f.db.eventLog.create.mock.calls)).not.toContain('000123456');
    f.setFunds('0');
    await expect(f.service.revealBank(1, 1)).rejects.toThrow('Available earnings changed');
  });

  it('denies suspended owners and protects every administrative route from dealer/operator access', async () => {
    const f = fixture();
    f.owner.isActive = false;
    await expect(f.service.requestPayout(7, { amount: '10', requestKey })).rejects.toThrow(ForbiddenException);
    for (const method of ['list', 'listUsers', 'listRoleDefaults', 'saveProfile', 'roleDefaults', 'settings', 'reveal', 'transition', 'recover'])
      expect(Reflect.getMetadata(ROLES_KEY, ReferralsController.prototype[method])).toEqual(['admin']);
    for (const method of ['dashboard', 'link', 'bank', 'request', 'cancel'])
      expect(Reflect.getMetadata(ROLES_KEY, ReferralsController.prototype[method])).toEqual(['client', 'dealer']);
  });
});

describe('referral administration views', () => {
  function accountsFixture() {
    const f = fixture();
    const users = Array.from({ length: 500 }, (_, index) => ({ ...f.owner, id: index + 10,
      firstName: index % 10 === 0 ? 'Selected' : 'User', username: `account${index}`, referralProfile: null }));
    const matching = (where: any) => users.filter(user => where.role.name.in.includes(user.role.name) &&
      user.deletedAt === where.deletedAt && (!where.OR || where.OR.some((filter: any) =>
        Object.entries(filter).some(([field, rule]: [string, any]) => String(user[field]).includes(rule.contains)))));
    f.db.user.count = jest.fn(async ({ where }) => matching(where).length);
    f.db.user.findMany = jest.fn(async ({ where, orderBy, skip, take }) =>
      matching(where).sort((a, b) => orderBy.id === 'desc' ? b.id - a.id : a.id - b.id).slice(skip, skip + take));
    f.db.$transaction = jest.fn(async (run: any) => run(f.db));
    return { ...f, users };
  }

  it.each([0, 10, 19])('reads only 25 of 500 accounts on page %i with a stable descending order', async page => {
    const f = accountsFixture();
    const result = await f.service.listAdminUsers(1, '', page);
    expect(result).toMatchObject({ userCount: 500, page, pages: 20, limit: 25 });
    expect(result.users).toHaveLength(25);
    expect(result.users.map(user => user.id)).toEqual(Array.from({ length: 25 }, (_, index) => 509 - page * 25 - index));
    expect(f.db.user.findMany).toHaveBeenCalledTimes(1);
    expect(f.db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25, skip: page * 25, orderBy: { id: 'desc' } }));
    expect(f.db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
    expect(f.db.referralProfile.upsert).not.toHaveBeenCalled();
  });

  it('filters both the count and the selected page and does not load all matching users', async () => {
    const f = accountsFixture();
    const result = await f.service.listAdminUsers(1, '  Selected  ', 1);
    expect(result).toMatchObject({ userCount: 50, page: 1, pages: 2, limit: 25 });
    expect(result.users).toHaveLength(25);
    expect(result.users.every(user => user.firstName === 'Selected')).toBe(true);
    expect(f.db.user.count.mock.calls[0][0].where).toEqual(f.db.user.findMany.mock.calls[0][0].where);
    expect(f.db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25, skip: 25 }));
    expect(f.db.user.count).toHaveBeenCalledWith({ where: expect.objectContaining({ deletedAt: null,
      role: { name: { in: ['client', 'dealer'] } }, OR: expect.arrayContaining([{ firstName: { contains: 'Selected' } }]) }) });
  });

  it('clamps a page that no longer exists and reports an empty search as page zero', async () => {
    const f = accountsFixture();
    const last = await f.service.listAdminUsers(1, '', 999);
    expect(last).toMatchObject({ page: 19, pages: 20, userCount: 500 });
    expect(last.users.map(user => user.id)).toEqual(Array.from({ length: 25 }, (_, index) => 34 - index));
    const empty = await f.service.listAdminUsers(1, 'No matching account', 19);
    expect(empty).toMatchObject({ users: [], page: 0, pages: 1, userCount: 0, limit: 25 });
    expect(f.db.user.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 25, skip: 0 }));
  });

  it('rejects malformed pages and searches before querying the account list', async () => {
    const f = accountsFixture();
    for (const page of [-1, 0.5, NaN, Infinity, 1000001])
      await expect(f.service.listAdminUsers(1, '', page)).rejects.toThrow(BadRequestException);
    await expect(f.service.listAdminUsers(1, [] as any)).rejects.toThrow(BadRequestException);
    expect(f.db.user.findMany).not.toHaveBeenCalled();
    expect(f.db.user.count).not.toHaveBeenCalled();
  });

  it('loads role defaults independently from users, withdrawals and financial summaries', async () => {
    const f = accountsFixture();
    const result = await f.service.listAdminRoleDefaults(1);
    expect(result.roleDefaults).toHaveLength(6);
    expect(result.roleDefaults.find(row => row.role === 'CLIENT')).toMatchObject({ percent: '10' });
    expect(f.db.user.findMany).not.toHaveBeenCalled();
    expect(f.db.user.count).not.toHaveBeenCalled();
    expect(f.db.referralSettings.findUnique).not.toHaveBeenCalled();
    expect(f.db.referralPayout.findUnique).not.toHaveBeenCalled();
  });

  it('keeps the overview focused on summary and withdrawals without fetching users or defaults', async () => {
    const f = accountsFixture();
    f.db.referralPayout.findMany = jest.fn(async () => []); f.db.referralPayout.count = jest.fn(async () => 0);
    f.db.referralReward.groupBy = jest.fn(async () => []); f.db.referralPayout.groupBy = jest.fn(async () => []);
    const result = await f.service.listAdmin(1);
    expect(result).toMatchObject({ settings: { minimumWithdrawal: '0' }, payouts: [], payoutsPage: 0, payoutPages: 1,
      payoutCount: 0, payoutStatus: 'OPEN', summary: { earned: '0.00', paid: '0.00' } });
    expect(result).not.toHaveProperty('users');
    expect(result).not.toHaveProperty('roleDefaults');
    expect(f.db.user.findMany).not.toHaveBeenCalled();
    expect(f.db.user.count).not.toHaveBeenCalled();
    expect(f.db.referralRoleDefault.findMany).not.toHaveBeenCalled();
  });

  it('requires an active administrator for both settings read views', async () => {
    const f = accountsFixture();
    for (const actor of [{ role: { name: 'client' }, isActive: true }, { role: { name: 'dealer' }, isActive: true },
      { role: { name: 'operator' }, isActive: true }, { role: { name: 'admin' }, isActive: false },
      { role: { name: 'admin' }, isActive: true, deletedAt: new Date() }]) {
      f.db.user.findUnique.mockResolvedValue(actor);
      await expect(f.service.listAdminUsers(1)).rejects.toThrow(ForbiddenException);
      await expect(f.service.listAdminRoleDefaults(1)).rejects.toThrow(ForbiddenException);
    }
    expect(f.db.user.findMany).not.toHaveBeenCalled();
    expect(f.db.referralRoleDefault.findMany).not.toHaveBeenCalled();
  });
});
