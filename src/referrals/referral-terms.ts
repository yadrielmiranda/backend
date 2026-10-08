import { BadRequestException } from '@nestjs/common';
import { Prisma, ReferralRewardMode, ReferralRole } from '@prisma/client';
import Decimal from 'decimal.js';
import { accountNetworkBlocked } from '@/dealer-network/network-access';
import { earningsPlanSnapshot } from '@/earnings-plans/earnings-plan';

type ReferralUser = {
  role: { name: string };
  parentDealerId?: number | null;
  dealerMode?: string | null;
  parentDealer?: { parentDealerId?: number | null } | null;
};

export const referralRoles = [ReferralRole.CLIENT, ReferralRole.DISTRIBUTOR, ReferralRole.SUBDEALER_INTERNAL,
  ReferralRole.SUBDEALER_EXTERNAL, ReferralRole.DEALER_EXTERNAL, ReferralRole.DEALER_INTERNAL];

export function referralRole(user: ReferralUser): ReferralRole | null {
  if (user.role.name === 'client') return ReferralRole.CLIENT;
  if (user.role.name !== 'dealer') return null;
  if (user.parentDealerId != null) {
    if (user.parentDealer?.parentDealerId != null) return ReferralRole.DISTRIBUTOR;
    return user.dealerMode === 'INTERNAL' ? ReferralRole.SUBDEALER_INTERNAL : ReferralRole.SUBDEALER_EXTERNAL;
  }
  return user.dealerMode === 'INTERNAL' ? ReferralRole.DEALER_INTERNAL : ReferralRole.DEALER_EXTERNAL;
}

export function referralRoleModes(role: ReferralRole): ReferralRewardMode[] {
  return role === ReferralRole.DEALER_EXTERNAL ? [ReferralRewardMode.EXTERNAL_MARGIN]
    : role === ReferralRole.DEALER_INTERNAL ? [ReferralRewardMode.CUSTOM_PERCENT, ReferralRewardMode.DEALER_PLAN]
    : [ReferralRewardMode.CUSTOM_PERCENT];
}

export function initialReferralDefault(role: ReferralRole) {
  const mode = referralRoleModes(role)[0];
  return { role, mode, percent: mode === ReferralRewardMode.CUSTOM_PERCENT ? '0' : null, revision: 1 };
}

export function effectiveReferralProfile<T extends { mode: ReferralRewardMode; percent: { toString(): string } | string | null;
  revision: number; enabled: boolean; useRoleDefaults?: boolean }>(profile: T, user: ReferralUser,
  defaults: Array<{ role: ReferralRole; mode: ReferralRewardMode; percent: { toString(): string } | string | null; revision: number }>) {
  const role = referralRole(user);
  if (!role) return null;
  // Undefined supports immutable historical fixtures; all persisted profiles have the migration's explicit flag.
  if (profile.useRoleDefaults !== true && referralRoleModes(role).includes(profile.mode))
    return { ...profile, referralRole: role, roleRevision: null };
  const terms = defaults.find(row => row.role === role) ?? initialReferralDefault(role);
  return { ...profile, useRoleDefaults: profile.useRoleDefaults === true || profile.enabled, enabled: profile.useRoleDefaults === true || profile.enabled,
    mode: terms.mode, percent: terms.percent, referralRole: role, roleRevision: terms.revision };
}

export function allowedReferralModes(user: ReferralUser): ReferralRewardMode[] {
  const role = referralRole(user);
  return role ? referralRoleModes(role) : [];
}

const referralUserInclude = { role: true, dealerEarningsPlan: true, parentDealer: { select: { parentDealerId: true, isActive: true } } } satisfies Prisma.UserInclude;

export function referralTerms(profile: {
  mode: ReferralRewardMode; percent: { toString(): string } | string | null; revision: number;
  useRoleDefaults?: boolean; referralRole?: ReferralRole; roleRevision?: number | null;
  user: Prisma.UserGetPayload<{ include: typeof referralUserInclude }>;
}) {
  if (!allowedReferralModes(profile.user).includes(profile.mode)) return null;
  const common = { version: 1 as const, mode: profile.mode, profileRevision: profile.revision,
    lockedAt: new Date().toISOString(), dealerPriceBasis: 'SAVED_UNIT_APP_BASE' as const,
    ...(profile.referralRole ? { referralRole: profile.referralRole, source: profile.useRoleDefaults ? 'ROLE_DEFAULT' : 'INDIVIDUAL', roleRevision: profile.roleRevision } : {}) };
  if (profile.mode === 'CUSTOM_PERCENT') {
    if (profile.percent == null) return null;
    const percent = new Decimal(profile.percent.toString());
    return percent.isFinite() && percent.gte(0) && percent.lte(100)
      ? { ...common, percent: percent.toString() } : null;
  }
  const markup = new Decimal((profile.user.markupOverride ?? profile.user.role.markup).toString());
  if (!markup.isFinite() || markup.lt(0)) return null;
  if (profile.mode === 'EXTERNAL_MARGIN') return { ...common, dealerMarkup: markup.toString() };
  const plan = profile.user.dealerEarningsPlan;
  if (!plan?.isActive) return { ...common, dealerMarkup: markup.toString(), earningsPlan: null,
    configurationIssue: 'MISSING_DEALER_PLAN' as const };
  return { ...common, dealerMarkup: markup.toString(), earningsPlan: earningsPlanSnapshot(plan) };
}

// Only new client registrations can create attribution. This never assigns a commercial parent.
export async function resolveRegistrationReferral(db: Prisma.TransactionClient, code?: string) {
  if (code === undefined) return null;
  const invalid = () => new BadRequestException('This referral link is unavailable. Ask the person who shared it for an active link.');
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(code)) throw invalid();
  const profile = await db.referralProfile.findUnique({
    where: { code }, include: { user: { include: referralUserInclude } },
  });
  if (!profile || (profile.useRoleDefaults !== true && !profile.enabled) || !profile.linkCreatedAt || !referralRole(profile.user) || profile.user.networkSuspendedByAdmin ||
      await accountNetworkBlocked(db, profile.user, true)) throw invalid();
  return profile;
}

// Called only in the transaction creating a new order, never backfilled from a dashboard read.
export async function snapshotReferralReward(db: Prisma.TransactionClient, orderId: number, clientUserId: number) {
  const attribution = await db.referralAttribution.findUnique({
    where: { referredUserId: clientUserId },
    include: { referredUser: { select: { role: { select: { name: true } } } },
      profile: { include: { user: { include: referralUserInclude } } } },
  });
  if (!attribution || attribution.referredUser.role.name !== 'client' ||
      attribution.profile.userId === clientUserId || (attribution.profile.useRoleDefaults !== true && !attribution.profile.enabled) || attribution.profile.user.networkSuspendedByAdmin ||
      await accountNetworkBlocked(db, attribution.profile.user, true)) return;
  const defaults = attribution.profile.useRoleDefaults === true || !allowedReferralModes(attribution.profile.user).includes(attribution.profile.mode)
    ? await db.referralRoleDefault.findMany() : [];
  const effective = effectiveReferralProfile(attribution.profile, attribution.profile.user, defaults);
  const terms = effective && referralTerms(effective);
  if (!terms) return;
  await db.referralReward.create({ data: {
    orderId, profileId: attribution.profileId, attributionId: attribution.id,
    terms: terms as Prisma.InputJsonObject,
    ...(terms.mode === 'DEALER_PLAN' && !('earningsPlan' in terms && terms.earningsPlan) ? { reason: 'PENDING_REVIEW' } : {}),
  } });
}
