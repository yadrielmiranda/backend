import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReferralRole, ReferralRewardMode } from '@prisma/client';
import { randomBytes } from 'crypto';
import Decimal from 'decimal.js';
import { PrismaService } from '@/prisma/prisma.service';
import { ReferralBankCipher, validateReferralBank } from './referral-bank';
import { allowedReferralModes, effectiveReferralProfile, initialReferralDefault, referralRole, referralRoleModes, referralRoles, resolveRegistrationReferral } from './referral-terms';
import { calculateReferralReward, referralRewardEstimateInclude } from './referral-rewards';
import { RecoverReferralPayoutDto, RequestReferralPayoutDto, SaveReferralBankDto, SaveReferralProfileDto, SaveReferralRoleDefaultDto, SaveReferralSettingsDto, TransitionReferralPayoutDto } from './referrals.dto';

const MAX_AMOUNT = new Decimal('9999999999999999.99');
const PAGE_SIZE = 100;
const ADMIN_USERS_PAGE_SIZE = 25;
const ACTIVE_PAYOUTS = ['REQUESTED', 'PROCESSING'];
const userSelection = { id: true, firstName: true, lastName: true, username: true, parentDealerId: true, dealerMode: true,
  isActive: true, deletedAt: true, networkSuspended: true, networkSuspendedByAdmin: true,
  parentDealer: { select: { parentDealerId: true } },
  role: { select: { name: true } }, dealerEarningsPlan: { select: { id: true, isActive: true } } } as const;

function validPage(page: number) {
  if (!Number.isSafeInteger(page) || page < 0 || page > 1000000) throw new BadRequestException('Choose a valid history page.');
  return page;
}

export function referralMoney(value: unknown, allowZero = false): Decimal {
  if (typeof value !== 'string' || !/^\d{1,16}(?:\.\d{1,2})?$/.test(value))
    throw new BadRequestException('Enter an amount in dollars with no more than two decimal places.');
  const amount = new Decimal(value);
  if (amount.gt(MAX_AMOUNT) || (allowZero ? amount.lt(0) : amount.lte(0)))
    throw new BadRequestException(allowZero ? 'Enter a valid nonnegative amount.' : 'Enter an amount greater than zero.');
  return amount;
}

export function referralBalances(earned: Decimal.Value, available: Decimal.Value, reserved: Decimal.Value, paid: Decimal.Value) {
  const remaining = new Decimal(available).minus(reserved).minus(paid);
  return {
    pending: Decimal.max(0, new Decimal(earned).minus(available)).toFixed(2),
    available: Decimal.max(0, remaining).toFixed(2), reserved: new Decimal(reserved).toFixed(2), paid: new Decimal(paid).toFixed(2),
    adjustmentDebt: Decimal.max(0, remaining.negated()).toFixed(2),
  };
}

export function referralSummary(
  rewards: Array<{ profileId: number; earnedAmount: string; availableAmount: string }>,
  payouts: Array<{ profileId: number; status: string; amount: string; bankFee: string }>,
) {
  const profiles = new Map<number, { earned: Decimal; available: Decimal; reserved: Decimal; paid: Decimal; fees: Decimal }>();
  const account = (id: number) => {
    if (!profiles.has(id)) profiles.set(id, { earned: new Decimal(0), available: new Decimal(0), reserved: new Decimal(0), paid: new Decimal(0), fees: new Decimal(0) });
    return profiles.get(id)!;
  };
  for (const row of rewards) {
    const current = account(row.profileId);
    current.earned = current.earned.add(row.earnedAmount);
    current.available = current.available.add(row.availableAmount);
  }
  for (const row of payouts) {
    const current = account(row.profileId);
    if (ACTIVE_PAYOUTS.includes(row.status)) current.reserved = current.reserved.add(row.amount);
    if (row.status === 'PAID') { current.paid = current.paid.add(row.amount); current.fees = current.fees.add(row.bankFee); }
  }
  const totals = { earned: new Decimal(0), pending: new Decimal(0), available: new Decimal(0), reserved: new Decimal(0), paid: new Decimal(0), adjustmentDebt: new Decimal(0), bankFees: new Decimal(0) };
  for (const current of profiles.values()) {
    const balances = referralBalances(current.earned, current.available, current.reserved, current.paid);
    totals.earned = totals.earned.add(current.earned);
    totals.bankFees = totals.bankFees.add(current.fees);
    for (const key of ['pending', 'available', 'reserved', 'paid', 'adjustmentDebt'] as const) totals[key] = totals[key].add(balances[key]);
  }
  return Object.fromEntries(Object.entries(totals).map(([key, amount]) => [key, amount.toFixed(2)])) as Record<keyof typeof totals, string>;
}

function profileDto(profile: any, admin = false) {
  return { enabled: profile.enabled, code: profile.linkCreatedAt ? profile.code : null,
    linkCreatedAt: profile.linkCreatedAt,
    ...(admin ? { mode: profile.mode, percent: profile.percent?.toString() ?? null, useRoleDefaults: profile.useRoleDefaults } : {}) };
}

function rewardPercent(mode: ReferralRewardMode, value?: string) {
  if (mode !== 'CUSTOM_PERCENT') return null;
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,4})?$/.test(value) || new Decimal(value).gt(100))
    throw new BadRequestException('Enter an earnings percentage between 0 and 100.');
  return new Decimal(value).toString();
}

function publicRewardReason(reason: string) {
  return ['PENDING_COST', 'PENDING_REAL_COST'].includes(reason) ? 'PENDING_REVIEW' : reason;
}

function payoutDto(payout: any, admin = false) {
  return { id: payout.id, amount: payout.amount.toString(), status: payout.status, requestedAt: payout.createdAt,
    paidAt: payout.paidAt, reference: payout.reference, note: payout.events?.[0]?.note ?? null,
    bankName: payout.bankName, accountLast4: payout.accountLast4,
    ...(admin ? { userId: payout.profile?.userId, userName: [payout.profile?.user?.firstName, payout.profile?.user?.lastName].filter(Boolean).join(' '),
      bankFee: payout.bankFee.toString(), proofReference: payout.proofReference, processingById: payout.processingById ?? null } : {}) };
}

@Injectable()
export class ReferralsService {
  constructor(private readonly prisma: PrismaService, private readonly bankCipher: ReferralBankCipher) {}

  private async activeOwner(db: Prisma.TransactionClient, userId: number) {
    const user = await db.user.findUnique({ where: { id: userId }, select: userSelection });
    if (!user || !['client', 'dealer'].includes(user.role.name)) throw new ForbiddenException('This account cannot use referrals.');
    let current: any = user;
    const seen = new Set<number>();
    while (current) {
      if (seen.has(current.id) || seen.size > 3 || !current.isActive || current.deletedAt || current.networkSuspended || current.networkSuspendedByAdmin)
        throw new ForbiddenException('Referral withdrawals are unavailable for this account. Contact the administrator.');
      seen.add(current.id);
      if (!current.parentDealerId) break;
      current = await db.user.findUnique({ where: { id: current.parentDealerId }, select: userSelection });
      if (!current) throw new ForbiddenException('The account network is unavailable.');
    }
    return user;
  }

  private async admin(actorId: number) {
    const actor = await this.prisma.user.findUnique({ where: { id: actorId }, select: { role: { select: { name: true } }, isActive: true, deletedAt: true } });
    if (!actor?.isActive || actor.deletedAt || actor.role.name !== 'admin') throw new ForbiddenException('Administrator access is required.');
  }

  private async profileForOwner(userId: number) {
    const user = await this.activeOwner(this.prisma, userId);
    return this.prisma.referralProfile.upsert({ where: { userId }, update: {}, create: {
      userId, code: randomBytes(18).toString('hex'), mode: allowedReferralModes(user)[0], enabled: true, useRoleDefaults: true,
    } });
  }

  private async audit(db: Prisma.TransactionClient, actorId: number, id: number, message: string, entityType = 'ReferralPayout') {
    await db.eventLog.create({ data: { userId: actorId, entityType, entityId: id, action: 'UPDATE', message } });
  }

  /** Estimate locks match payment/refund writers; the profile lock serializes reservations. */
  private async refreshed<T>(profileId: number, run: (db: Prisma.TransactionClient, profile: any) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async db => {
      const known = await db.referralReward.findMany({ where: { profileId }, select: { id: true, order: { select: { idEst: true } } } });
      const estimateIds = [...new Set(known.map(row => row.order.idEst))].sort((a, b) => a - b);
      for (const id of estimateIds) await db.$queryRaw`SELECT id FROM Estimate WHERE id = ${id} FOR UPDATE`;
      await db.$queryRaw`SELECT id FROM ReferralProfile WHERE id = ${profileId} FOR UPDATE`;
      const profile = await db.referralProfile.findUnique({ where: { id: profileId } });
      if (!profile) throw new NotFoundException('Referral account not found.');
      const [rewards, estimates] = known.length ? await Promise.all([
        db.referralReward.findMany({ where: { id: { in: known.map(row => row.id) } } }),
        db.estimate.findMany({ where: { id: { in: estimateIds } }, include: referralRewardEstimateInclude }),
      ]) : [[], []];
      const rewardsById = new Map(rewards.map(reward => [reward.id, reward]));
      const estimatesById = new Map(estimates.map(estimate => [estimate.id, estimate]));
      const unchangedByReason = new Map<string, number[]>();
      const evaluatedAt = new Date();
      for (const item of known) {
        const reward = rewardsById.get(item.id);
        const estimate = estimatesById.get(item.order.idEst);
        if (!reward || !estimate) continue;
        const result = calculateReferralReward(estimate, reward.terms as any);
        const earnedAmount = new Decimal(result.earnedAmount);
        const availableAmount = new Decimal(result.availableAmount);
        const earnedDelta = earnedAmount.minus(reward.earnedAmount.toString());
        const availableDelta = availableAmount.minus(reward.availableAmount.toString());
        if (!earnedDelta.isZero() || !availableDelta.isZero()) {
          await db.referralLedgerEntry.create({ data: { rewardId: reward.id, earnedDelta: earnedDelta.toFixed(2),
            availableDelta: availableDelta.toFixed(2), reason: result.reason } });
          await db.referralReward.update({ where: { id: reward.id }, data: { earnedAmount: earnedAmount.toFixed(2), availableAmount: availableAmount.toFixed(2),
            reason: result.reason, evaluatedAt } });
        } else {
          const ids = unchangedByReason.get(result.reason) ?? [];
          ids.push(reward.id);
          unchangedByReason.set(result.reason, ids);
        }
      }
      for (const [reason, ids] of unchangedByReason) await db.referralReward.updateMany({ where: { id: { in: ids } }, data: { reason, evaluatedAt } });
      return run(db, profile);
    }, { maxWait: 10000, timeout: 60000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  private async balances(db: Prisma.TransactionClient, profileId: number) {
    const [rewards, reserved, paid] = await Promise.all([
      db.referralReward.aggregate({ where: { profileId }, _sum: { earnedAmount: true, availableAmount: true } }),
      db.referralPayout.aggregate({ where: { profileId, status: { in: ACTIVE_PAYOUTS as any } }, _sum: { amount: true } }),
      db.referralPayout.aggregate({ where: { profileId, status: 'PAID' }, _sum: { amount: true } }),
    ]);
    return referralBalances(rewards._sum.earnedAmount?.toString() ?? '0', rewards._sum.availableAmount?.toString() ?? '0',
      reserved._sum.amount?.toString() ?? '0', paid._sum.amount?.toString() ?? '0');
  }

  async dashboard(userId: number, referralsPage = 0, rewardsPage = 0, payoutsPage = 0) {
    [referralsPage, rewardsPage, payoutsPage].forEach(validPage);
    const found = await this.profileForOwner(userId);
    return this.refreshed(found.id, async (db, profile) => {
      const [balances, settings, bank, referrals, rewards, payouts, referralCount, rewardCount, payoutCount] = await Promise.all([
        this.balances(db, profile.id), db.referralSettings.findUnique({ where: { id: 1 } }), db.referralBankAccount.findUnique({ where: { profileId: profile.id } }),
        db.referralAttribution.findMany({ where: { profileId: profile.id }, orderBy: { id: 'desc' }, take: PAGE_SIZE, skip: referralsPage * PAGE_SIZE,
          include: { referredUser: { select: { firstName: true } }, rewards: { select: { earnedAmount: true } } } }),
        db.referralReward.findMany({ where: { profileId: profile.id }, orderBy: { id: 'desc' }, take: PAGE_SIZE, skip: rewardsPage * PAGE_SIZE,
          include: { attribution: { select: { referredUser: { select: { firstName: true } } } } } }),
        db.referralPayout.findMany({ where: { profileId: profile.id }, orderBy: { id: 'desc' }, take: PAGE_SIZE, skip: payoutsPage * PAGE_SIZE,
          include: { events: { orderBy: { id: 'desc' }, take: 1 } } }),
        db.referralAttribution.count({ where: { profileId: profile.id } }), db.referralReward.count({ where: { profileId: profile.id } }),
        db.referralPayout.count({ where: { profileId: profile.id } }),
      ]);
      const details = bank ? this.bankCipher.decrypt(bank.encryptedDetails, `profile:${profile.id}`) : null;
      return { profile: profileDto(profile), balances, minimumWithdrawal: settings?.minimumWithdrawal.toString() ?? '0.00',
        bank: bank ? { holderName: details.holderName, holderType: bank.holderType, bankName: bank.bankName, accountType: bank.accountType,
          accountLast4: bank.accountLast4, routingLast4: details.routingNumber.slice(-4), updatedAt: bank.updatedAt } : null,
        referrals: referrals.map(row => ({ id: row.id, firstName: row.referredUser.firstName, joinedAt: row.createdAt,
          rewardTotal: row.rewards.reduce((sum, reward) => sum.add(reward.earnedAmount.toString()), new Decimal(0)).toFixed(2) })),
        rewards: rewards.map(row => ({ id: row.id, firstName: row.attribution.referredUser.firstName, createdAt: row.createdAt,
          amount: row.earnedAmount.toString(), status: publicRewardReason(row.reason), reason: publicRewardReason(row.reason) })),
        payouts: payouts.map(row => payoutDto(row)), referralCount, rewardCount, payoutCount,
        referralsPage, rewardsPage, payoutsPage, referralPages: Math.max(1, Math.ceil(referralCount / PAGE_SIZE)),
        rewardPages: Math.max(1, Math.ceil(rewardCount / PAGE_SIZE)), payoutPages: Math.max(1, Math.ceil(payoutCount / PAGE_SIZE)),
        counts: { referrals: referralCount, rewards: rewardCount, payouts: payoutCount }, limit: PAGE_SIZE };
    });
  }

  async createLink(userId: number) {
    const found = await this.profileForOwner(userId);
    return this.prisma.$transaction(async db => {
      await db.$queryRaw`SELECT id FROM ReferralProfile WHERE id = ${found.id} FOR UPDATE`;
      const profile = await db.referralProfile.findUnique({ where: { id: found.id } });
      await this.activeOwner(db, userId);
      if (!profile || (profile.useRoleDefaults !== true && !profile.enabled))
        throw new BadRequestException('Your referral link is unavailable. Contact the administrator.');
      const result = await db.referralProfile.update({ where: { id: profile.id }, data: { linkCreatedAt: profile.linkCreatedAt ?? new Date() } });
      return profileDto(result);
    });
  }

  async resolve(code: string) {
    const profile = await resolveRegistrationReferral(this.prisma, code);
    if (!profile) throw new NotFoundException('This referral link is unavailable.');
    return { valid: true, code: profile.code };
  }

  async saveBank(userId: number, input: SaveReferralBankDto) {
    const details = validateReferralBank(input);
    const found = await this.profileForOwner(userId);
    const encryptedDetails = this.bankCipher.encrypt(details, `profile:${found.id}`);
    return this.prisma.$transaction(async db => {
      await db.$queryRaw`SELECT id FROM ReferralProfile WHERE id = ${found.id} FOR UPDATE`;
      await this.activeOwner(db, userId);
      const values = { encryptedDetails, accountLast4: details.accountNumber.slice(-4), bankName: details.bankName,
        accountType: details.accountType, holderType: details.holderType };
      const bank = await db.referralBankAccount.upsert({ where: { profileId: found.id }, create: { profileId: found.id, ...values },
        update: { ...values, revision: { increment: 1 } } });
      await this.audit(db, userId, found.id, 'Referral payout bank account updated; existing payout destinations remain unchanged.', 'ReferralProfile');
      return { holderName: details.holderName, holderType: bank.holderType, bankName: bank.bankName, accountType: bank.accountType,
        accountLast4: bank.accountLast4, routingLast4: details.routingNumber.slice(-4), updatedAt: bank.updatedAt };
    });
  }

  async requestPayout(userId: number, input: RequestReferralPayoutDto) {
    const amount = referralMoney(input.amount);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestKey))
      throw new BadRequestException('Provide a valid payout request identifier.');
    const found = await this.profileForOwner(userId);
    return this.refreshed(found.id, async (db, profile) => {
      await this.activeOwner(db, userId);
      const existing = await db.referralPayout.findUnique({ where: { requestKey: input.requestKey } });
      if (existing) {
        if (existing.profileId !== profile.id || !amount.eq(existing.amount.toString()))
          throw new ConflictException('This payout request identifier has already been used.');
        return payoutDto(existing);
      }
      const balances = await this.balances(db, profile.id);
      const settings = await db.referralSettings.findUnique({ where: { id: 1 } });
      if (amount.lt(settings?.minimumWithdrawal.toString() ?? '0')) throw new BadRequestException('The requested amount is below the minimum withdrawal.');
      if (amount.gt(balances.available) || new Decimal(balances.adjustmentDebt).gt(0))
        throw new BadRequestException('The requested amount exceeds your available referral earnings.');
      const bank = await db.referralBankAccount.findUnique({ where: { profileId: profile.id } });
      if (!bank) throw new BadRequestException('Add your US bank account before requesting a withdrawal.');
      const details = this.bankCipher.decrypt(bank.encryptedDetails, `profile:${profile.id}`);
      const encryptedDestination = this.bankCipher.encrypt(details, `payout:${profile.id}:${input.requestKey}`);
      const payout = await db.referralPayout.create({ data: { profileId: profile.id, requestKey: input.requestKey, amount: amount.toFixed(2),
        encryptedDestination, accountLast4: bank.accountLast4, bankName: bank.bankName,
        events: { create: { actorId: userId, status: 'REQUESTED' } } } });
      return payoutDto(payout);
    });
  }

  async cancelPayout(userId: number, payoutId: number) {
    const found = await this.profileForOwner(userId);
    return this.refreshed(found.id, async (db, profile) => {
      await this.activeOwner(db, userId);
      const payout = await db.referralPayout.findUnique({ where: { id: payoutId } });
      if (!payout || payout.profileId !== profile.id) throw new NotFoundException('Withdrawal not found.');
      if (payout.status === 'CANCELED') return payoutDto(payout);
      if (payout.status !== 'REQUESTED') throw new BadRequestException('Only withdrawals awaiting review can be canceled.');
      return payoutDto(await db.referralPayout.update({ where: { id: payout.id }, data: { status: 'CANCELED',
        events: { create: { actorId: userId, status: 'CANCELED' } } } }));
    });
  }

  async listAdmin(actorId: number, payoutsPage = 0, payoutStatus = 'OPEN') {
    await this.admin(actorId);
    validPage(payoutsPage);
    if (!['OPEN', 'ALL'].includes(payoutStatus))
      throw new BadRequestException('Choose a valid withdrawal page and filter.');
    const payoutWhere: Prisma.ReferralPayoutWhereInput = payoutStatus === 'OPEN' ? { status: { in: ['REQUESTED', 'PROCESSING'] } } : {};
    const [settings, payouts, payoutCount, rewardGroups, payoutGroups] = await Promise.all([
      this.prisma.referralSettings.findUnique({ where: { id: 1 } }),
      this.prisma.referralPayout.findMany({ where: payoutWhere, take: PAGE_SIZE, skip: payoutsPage * PAGE_SIZE,
        orderBy: { id: payoutStatus === 'OPEN' ? 'asc' : 'desc' }, include: {
        profile: { select: { userId: true, user: { select: { firstName: true, lastName: true } } } }, events: { orderBy: { id: 'desc' }, take: 1 },
      } }), this.prisma.referralPayout.count({ where: payoutWhere }),
      this.prisma.referralReward.groupBy({ by: ['profileId'], _sum: { earnedAmount: true, availableAmount: true }, _max: { evaluatedAt: true } }),
      this.prisma.referralPayout.groupBy({ by: ['profileId', 'status'], where: { status: { in: ['REQUESTED', 'PROCESSING', 'PAID'] } }, _sum: { amount: true, bankFee: true } }),
    ]);
    const summary = referralSummary(rewardGroups.map(row => ({ profileId: row.profileId, earnedAmount: row._sum.earnedAmount?.toString() ?? '0',
      availableAmount: row._sum.availableAmount?.toString() ?? '0' })), payoutGroups.map(row => ({ profileId: row.profileId, status: row.status,
      amount: row._sum.amount?.toString() ?? '0', bankFee: row._sum.bankFee?.toString() ?? '0' })));
    const rewardsLastEvaluatedAt = rewardGroups.reduce<Date | null>((latest, row) => row._max.evaluatedAt && (!latest || row._max.evaluatedAt > latest) ? row._max.evaluatedAt : latest, null);
    return { settings: { minimumWithdrawal: settings?.minimumWithdrawal.toString() ?? '0.00' },
      payouts: payouts.map(payout => payoutDto(payout, true)), payoutCount, payoutsPage,
      payoutPages: Math.max(1, Math.ceil(payoutCount / PAGE_SIZE)), payoutStatus,
      summary: { ...summary, rewardsAreCached: true, rewardsLastEvaluatedAt } };
  }

  private async adminRoleDefaults(db: Prisma.TransactionClient) {
    const savedDefaults = await db.referralRoleDefault.findMany();
    return referralRoles.map(role => {
      const rule = savedDefaults.find(row => row.role === role) ?? initialReferralDefault(role);
      return { ...rule, percent: rule.percent?.toString() ?? null, allowedModes: referralRoleModes(role) };
    });
  }

  async listAdminRoleDefaults(actorId: number) {
    await this.admin(actorId);
    return { roleDefaults: await this.adminRoleDefaults(this.prisma) };
  }

  async listAdminUsers(actorId: number, query = '', page = 0) {
    await this.admin(actorId);
    validPage(page);
    if (typeof query !== 'string') throw new BadRequestException('Enter a valid account search.');
    const q = query.trim().slice(0, 100);
    const where: Prisma.UserWhereInput = { role: { name: { in: ['client', 'dealer'] } }, deletedAt: null,
      ...(q ? { OR: [{ firstName: { contains: q } }, { lastName: { contains: q } }, { username: { contains: q } }] } : {}) };
    // Keep the filtered count and page in one snapshot if accounts change during this read.
    return this.prisma.$transaction(async db => {
      const [userCount, roleDefaults] = await Promise.all([db.user.count({ where }), this.adminRoleDefaults(db)]);
      const pages = Math.max(1, Math.ceil(userCount / ADMIN_USERS_PAGE_SIZE));
      const currentPage = Math.min(page, pages - 1);
      const users = await db.user.findMany({ where, take: ADMIN_USERS_PAGE_SIZE, skip: currentPage * ADMIN_USERS_PAGE_SIZE,
        orderBy: { id: 'desc' }, select: { ...userSelection, referralProfile: true } });
      return { roleDefaults, users: users.map(user => {
        const base = user.referralProfile ?? { enabled: true, useRoleDefaults: true, mode: allowedReferralModes(user)[0], percent: null,
          revision: 1, code: null, linkCreatedAt: null };
        const profile = effectiveReferralProfile(base, user, roleDefaults)!;
        return { id: user.id, firstName: user.firstName, lastName: user.lastName, username: user.username, role: user.role.name,
          dealerMode: user.dealerMode, parentDealerId: user.parentDealerId, allowedModes: allowedReferralModes(user),
          referralRole: referralRole(user), useRoleDefaults: profile.useRoleDefaults,
          configurationIssue: profile.mode === 'DEALER_PLAN' && !user.dealerEarningsPlan?.isActive ? 'MISSING_DEALER_PLAN' : null,
          profile: profileDto(profile, true) };
      }), userCount, page: currentPage, pages, limit: ADMIN_USERS_PAGE_SIZE };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async saveProfile(actorId: number, userId: number, input: SaveReferralProfileDto) {
    await this.admin(actorId);
    if (typeof input.useRoleDefaults !== 'boolean') throw new BadRequestException('Choose role defaults or individual settings.');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: userSelection });
    if (!user || !['client', 'dealer'].includes(user.role.name)) throw new NotFoundException('Referral account not found.');
    const mode = input.useRoleDefaults ? allowedReferralModes(user)[0] : input.mode;
    if (!mode || !allowedReferralModes(user).includes(mode)) throw new BadRequestException('This earnings arrangement is not available for this account.');
    if (!input.useRoleDefaults && typeof input.enabled !== 'boolean')
      throw new BadRequestException('Choose whether the referral arrangement is enabled.');
    const percent = input.useRoleDefaults ? null : rewardPercent(mode, input.percent);
    if (!input.useRoleDefaults && input.enabled) {
      await this.activeOwner(this.prisma, userId);
    }
    return this.prisma.$transaction(async db => {
      const profile = await db.referralProfile.upsert({ where: { userId }, create: { userId, code: randomBytes(18).toString('hex'), mode }, update: {} });
      await db.$queryRaw`SELECT id FROM ReferralProfile WHERE id = ${profile.id} FOR UPDATE`;
      const before = await db.referralProfile.findUnique({ where: { id: profile.id } });
      const result = await db.referralProfile.update({ where: { id: profile.id }, data: {
        useRoleDefaults: input.useRoleDefaults, enabled: input.useRoleDefaults || input.enabled, mode, percent, revision: { increment: 1 },
      } });
      await db.eventLog.create({ data: { userId: actorId, entityType: 'ReferralProfile', entityId: profile.id, action: 'UPDATE',
        message: `Referral arrangement updated for account ${userId}; existing sale terms remain unchanged.`,
        tempLog: { create: { before: { useRoleDefaults: before.useRoleDefaults, enabled: before.enabled, mode: before.mode, percent: before.percent?.toString() ?? null, revision: before.revision },
          after: { useRoleDefaults: result.useRoleDefaults, enabled: result.enabled, mode: result.mode, percent: result.percent?.toString() ?? null, revision: result.revision } } },
      } });
      const defaults = input.useRoleDefaults ? await db.referralRoleDefault.findMany() : [];
      return profileDto(effectiveReferralProfile(result, user, defaults), true);
    });
  }

  async saveRoleDefault(actorId: number, value: string, input: SaveReferralRoleDefaultDto) {
    await this.admin(actorId);
    const role = referralRoles.find(role => role === value);
    if (!role) throw new BadRequestException('Choose a valid referral role.');
    if (!referralRoleModes(role).includes(input.mode)) throw new BadRequestException('This earnings arrangement is not available for this role.');
    const percent = rewardPercent(input.mode, input.percent);
    return this.prisma.$transaction(async db => {
      await db.referralRoleDefault.upsert({ where: { role }, create: initialReferralDefault(role), update: {} });
      await db.$queryRaw`SELECT role FROM ReferralRoleDefault WHERE role = ${role} FOR UPDATE`;
      const before = await db.referralRoleDefault.findUnique({ where: { role } });
      const result = await db.referralRoleDefault.update({ where: { role }, data: { mode: input.mode, percent, revision: { increment: 1 } } });
      const state = (row: typeof result) => ({ role: row.role, mode: row.mode, percent: row.percent?.toString() ?? null, revision: row.revision });
      await db.eventLog.create({ data: { userId: actorId, entityType: 'ReferralRoleDefault', entityId: referralRoles.indexOf(role) + 1,
        action: 'UPDATE', message: `Referral defaults updated for ${role}; individual exceptions and existing sale terms remain unchanged.`,
        tempLog: { create: { before: state(before), after: state(result) } } } });
      return { ...state(result), allowedModes: referralRoleModes(role) };
    });
  }

  async saveSettings(actorId: number, input: SaveReferralSettingsDto) {
    await this.admin(actorId);
    const minimumWithdrawal = referralMoney(input.minimumWithdrawal, true).toFixed(2);
    return this.prisma.$transaction(async db => {
      await db.referralSettings.upsert({ where: { id: 1 }, create: { id: 1, minimumWithdrawal }, update: { minimumWithdrawal } });
      await this.audit(db, actorId, 1, 'Referral minimum withdrawal updated.', 'ReferralSettings');
      return { minimumWithdrawal };
    });
  }

  async revealBank(actorId: number, payoutId: number) {
    await this.admin(actorId);
    const found = await this.prisma.referralPayout.findUnique({ where: { id: payoutId }, select: { profileId: true } });
    if (!found) throw new NotFoundException('Withdrawal not found.');
    return this.refreshed(found.profileId, async (db, profile) => {
      const payout = await db.referralPayout.findUnique({ where: { id: payoutId } });
      if (!payout) throw new NotFoundException('Withdrawal not found.');
      if (payout.status !== 'PROCESSING') throw new BadRequestException('Start processing this withdrawal before opening its bank details.');
      if (payout.processingById !== actorId) throw new ConflictException('This withdrawal is already being processed by another administrator.');
      await this.activeOwner(db, profile.userId);
      const balances = await this.balances(db, profile.id);
      if (new Decimal(balances.adjustmentDebt).gt(0))
        throw new BadRequestException('Available earnings changed. Review this withdrawal before sending any funds.');
      const details = this.bankCipher.decrypt(payout.encryptedDestination, `payout:${payout.profileId}:${payout.requestKey}`);
      await this.audit(db, actorId, payout.id, 'Administrator opened the frozen ACH destination for this withdrawal.');
      return details;
    });
  }

  async transition(actorId: number, payoutId: number, input: TransitionReferralPayoutDto) {
    return this.transitionPayout(actorId, payoutId, input);
  }

  async recover(actorId: number, payoutId: number, input: RecoverReferralPayoutDto) {
    if (input.bankOutcomeConfirmed !== true || !Number.isSafeInteger(input.expectedProcessingById) || input.expectedProcessingById < 1 ||
        !['PAID', 'FAILED'].includes(input.status) || !input.note?.trim())
      throw new BadRequestException('Confirm the bank outcome, the original processing administrator, and the recovery explanation.');
    if (input.status === 'PAID' && !input.proofReference?.trim())
      throw new BadRequestException('Record proof of the completed bank transfer before recovering a paid withdrawal.');
    return this.transitionPayout(actorId, payoutId, input, input.expectedProcessingById);
  }

  private async transitionPayout(actorId: number, payoutId: number, input: TransitionReferralPayoutDto, expectedProcessingById?: number) {
    await this.admin(actorId);
    const found = await this.prisma.referralPayout.findUnique({ where: { id: payoutId }, select: { profileId: true } });
    if (!found) throw new NotFoundException('Withdrawal not found.');
    return this.refreshed(found.profileId, async (db, profile) => {
      const payout = await db.referralPayout.findUnique({ where: { id: payoutId } });
      if (!payout || payout.profileId !== profile.id) throw new NotFoundException('Withdrawal not found.');
      if (expectedProcessingById != null) {
        if (payout.status !== 'PROCESSING') throw new BadRequestException('Only a processing withdrawal can have its bank outcome recovered.');
        if (payout.processingById !== expectedProcessingById)
          throw new ConflictException('The processing administrator changed. Reload this withdrawal before recording its bank outcome.');
      } else if (payout.status === 'PROCESSING' && payout.processingById !== actorId)
        throw new ConflictException('This withdrawal is already being processed by another administrator.');
      if (payout.status === input.status) return payoutDto(payout);
      const allowed = payout.status === 'REQUESTED' ? ['PROCESSING', 'REJECTED', 'CANCELED']
        : payout.status === 'PROCESSING' ? ['PAID', 'FAILED'] : [];
      if (!allowed.includes(input.status)) throw new BadRequestException('This withdrawal can no longer make that status change.');
      if (input.status === 'PROCESSING') {
        await this.activeOwner(db, profile.userId);
        const balances = await this.balances(db, profile.id);
        if (new Decimal(balances.adjustmentDebt).gt(0))
          throw new BadRequestException('Available earnings changed. Reject uncovered withdrawal requests before processing any payment.');
      }
      if (input.status === 'FAILED' && (input.confirmedNotSent !== true || !input.note?.trim()))
        throw new BadRequestException('Confirm that funds were not sent and explain the failure before releasing this balance.');
      if (['REJECTED', 'CANCELED'].includes(input.status) && !input.note?.trim())
        throw new BadRequestException('Explain why this withdrawal is being closed.');
      const data: any = { status: input.status, events: { create: { actorId, status: input.status, note: input.note?.trim() || null } } };
      if (input.status === 'PROCESSING') Object.assign(data, { processingAt: new Date(), processingById: actorId });
      if (input.status === 'PAID') {
        const paidAt = input.paidAt ? new Date(input.paidAt) : null;
        if (!input.reference?.trim() || !paidAt || Number.isNaN(paidAt.getTime()) || paidAt > new Date() || paidAt < payout.createdAt)
          throw new BadRequestException('Enter the ACH confirmation reference and a valid payment date after the request.');
        Object.assign(data, { reference: input.reference.trim(), paidAt, proofReference: input.proofReference?.trim() || null,
          bankFee: referralMoney(input.bankFee ?? '0', true).toFixed(2) });
      }
      const updated = await db.referralPayout.update({ where: { id: payout.id }, data });
      await this.audit(db, actorId, payout.id, expectedProcessingById == null
        ? `Referral withdrawal marked ${input.status}. Bank fees are paid by the company.`
        : `Verified bank outcome recovery: withdrawal marked ${input.status} by administrator ${actorId}; original processing administrator ${expectedProcessingById}. No new transfer was initiated.`);
      return payoutDto(updated);
    });
  }
}
