import {
  BadRequestException, ConflictException, ForbiddenException, Injectable,
  InternalServerErrorException, NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { createWithRegistrationUsername, identityConflict, UsernameTakenConflict } from '@/auth/client-username';
import { LogsService } from '@/logs/logs.service';
import { AccountWelcomeService } from '@/mail/account-welcome.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { PrismaService } from '@/prisma/prisma.service';
import { createNetworkAccount, networkMarkupFraction, networkMarkupPercent } from './create-network-account';
import { dealerChain, NETWORK_LABELS } from './dealer-network';
import type { SubmitDealerRegistrationDto } from './dealer-network.dto';
import { networkSalesBlocked } from './network-access';
import { applyDealerRegistrationConsent, captureDealerRegistrationConsent, registrationConsentSelect } from './dealer-registration-consent';
import { DealerRegistrationRejectionService } from './dealer-registration-rejection.service';

const invitationSelect = { id: true, token: true, parentDealerId: true, markupPercent: true } as const;
const applicantSelect = {
  username: true, firstName: true, lastName: true, email: true, phone: true,
  street: true, addressLine2: true, city: true, state: true, postalCode: true,
  companyName: true, estimatedMonthlySales: true, yearsOfExperience: true,
} as const;
const pendingSelect = {
  ...applicantSelect, id: true, createdAt: true, invite: { select: { markupPercent: true } },
} as const;

function actorParentId(actor: AuthUser): number | null {
  if (actor.role?.name === 'admin') return null;
  if (actor.role?.name === 'dealer') return actor.id;
  throw new ForbiddenException('Only administrators and inviting dealers can manage registrations.');
}

function scopeKey(parentDealerId: number | null) {
  return parentDealerId === null ? 'company' : `dealer:${parentDealerId}`;
}

function contactConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ConflictException('The username, email or phone is already in use.');
  }
  throw error;
}

@Injectable()
export class DealerRegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logs: LogsService,
    private readonly welcome: AccountWelcomeService,
    private readonly notifications: NotificationsService,
    private readonly rejections: DealerRegistrationRejectionService,
  ) {}

  private async dealerRole(db: Prisma.TransactionClient) {
    const role = await db.role.findUnique({ where: { name: 'dealer' }, select: { id: true, markup: true } });
    if (!role) throw new InternalServerErrorException('Dealer role is missing.');
    return role;
  }

  private async level(db: Prisma.TransactionClient, parentDealerId: number | null, lock = false) {
    if (parentDealerId === null) return NETWORK_LABELS[0];
    if (lock) {
      // A subdealer's ability to invite depends on its own account and its dealer.
      await db.$queryRaw`SELECT owner.id, parent.isActive FROM User owner
        LEFT JOIN User parent ON parent.id = owner.parentDealerId
        WHERE owner.id = ${parentDealerId} FOR UPDATE`;
    }
    const chain = await dealerChain(db, parentDealerId);
    if (chain.length >= NETWORK_LABELS.length) throw new ForbiddenException('Distributors cannot invite accounts.');
    if (chain.some(networkSalesBlocked)) throw new ForbiddenException('The inviting network is inactive or suspended.');
    return NETWORK_LABELS[chain.length];
  }

  async getInvitation(actor: AuthUser) {
    const parentDealerId = actorParentId(actor);
    const level = await this.level(this.prisma, parentDealerId);
    const invite = await this.prisma.dealerRegistrationInvite.findUnique({
      where: { scopeKey: scopeKey(parentDealerId) }, select: invitationSelect,
    });
    if (invite) return { token: invite.token, markupPercent: invite.markupPercent.toFixed(), level };
    const markupPercent = parentDealerId === null
      ? networkMarkupPercent((await this.dealerRole(this.prisma)).markup).toFixed() : '0';
    return { token: null, markupPercent, level };
  }

  async getMemberInvitation(actor: AuthUser, parentDealerId: number) {
    if (actor.role?.name !== 'admin') throw new ForbiddenException('Administrator access required.');
    const invite = await this.prisma.dealerRegistrationInvite.findUnique({
      where: {
        scopeKey: scopeKey(parentDealerId), parentDealerId,
        parentDealer: {
          deletedAt: null, role: { name: 'dealer' },
          OR: [{ parentDealerId: null }, { parentDealer: { parentDealerId: null } }],
        },
      },
      select: { token: true },
    });
    if (!invite) throw new NotFoundException('No invitation link exists for this account.');
    return invite;
  }

  async saveInvitation(actor: AuthUser, value: string | number) {
    const parentDealerId = actorParentId(actor);
    if (!/^-?\d{1,8}(?:\.\d{1,16})?$/.test(String(value))) {
      throw new BadRequestException('Enter a valid material markup percentage.');
    }
    const markupPercent = new Prisma.Decimal(value);
    if (parentDealerId === null && markupPercent.lte(-100)) {
      throw new BadRequestException('Custom markup must be greater than -100%.');
    }
    if (parentDealerId !== null && (markupPercent.lt(0) || markupPercent.gt(1000) || markupPercent.dp() > 4)) {
      throw new BadRequestException('Enter a markup from 0 to 1000% with at most four decimal places.');
    }
    return this.prisma.$transaction(async tx => {
      const level = await this.level(tx, parentDealerId, true);
      if (parentDealerId === null) {
        // Administrators share one company link, even when two first saves arrive together.
        await tx.$queryRaw`SELECT id FROM Role WHERE name = 'dealer' FOR UPDATE`;
        await this.dealerRole(tx);
      }
      const key = scopeKey(parentDealerId);
      const invite = await tx.dealerRegistrationInvite.upsert({
        where: { scopeKey: key }, update: { markupPercent },
        create: { scopeKey: key, parentDealerId, token: randomBytes(32).toString('hex'), markupPercent },
        select: invitationSelect,
      });
      return { token: invite.token, markupPercent: invite.markupPercent.toFixed(), level };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  private async findInvite(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new NotFoundException('Invitation unavailable.');
    const invite = await this.prisma.dealerRegistrationInvite.findUnique({ where: { token }, select: invitationSelect });
    if (!invite) throw new NotFoundException('Invitation unavailable.');
    return invite;
  }

  async publicInvitation(token: string) {
    const invite = await this.findInvite(token);
    const level = await this.level(this.prisma, invite.parentDealerId);
    if (invite.parentDealerId === null) return { level, inviter: null };

    const { firstName, lastName, branding } = await this.prisma.user.findUniqueOrThrow({
      where: { id: invite.parentDealerId },
      select: {
        firstName: true, lastName: true,
        branding: { where: { type: 'DEALER', isActive: true }, select: { name: true, logoUrl: true } },
      },
    });
    const inviter = branding?.name.trim()
      ? { name: branding.name.trim(), logoUrl: branding.logoUrl?.trim() || null }
      : { name: [firstName.trim(), lastName.trim()].filter(Boolean).join(' '), logoUrl: null };
    return { level, inviter };
  }

  async submit(token: string, dto: SubmitDealerRegistrationDto) {
    const initial = await this.findInvite(token);
    const passwordHash = await bcrypt.hash(dto.password, 10);
    try {
      return await this.prisma.$transaction(async tx => {
        const level = await this.level(tx, initial.parentDealerId, true);
        // Keep the historical submission value consistent with the invitation used.
        await tx.$queryRaw`SELECT id FROM DealerRegistrationInvite WHERE id = ${initial.id} LOCK IN SHARE MODE`;
        const invite = await tx.dealerRegistrationInvite.findUnique({ where: { token }, select: invitationSelect });
        if (!invite || invite.parentDealerId !== initial.parentDealerId) throw new NotFoundException('Invitation unavailable.');
        const consent = await captureDealerRegistrationConsent(tx, dto);
        const request = await createWithRegistrationUsername(tx, dto, async username => {
          const pending = await tx.dealerRegistrationRequest.create({
            data: {
              ...consent,
              inviteId: invite.id, markupPercent: invite.markupPercent, passwordHash,
              username, firstName: dto.firstName, lastName: dto.lastName, email: dto.email, phone: dto.phone,
              street: dto.street, addressLine2: dto.addressLine2, city: dto.city, state: dto.state, postalCode: dto.postalCode,
              companyName: dto.companyName, estimatedMonthlySales: dto.estimatedMonthlySales,
              yearsOfExperience: dto.yearsOfExperience,
            },
            select: { id: true, username: true },
          });
          // Check after claiming the pending identity keys: an account may have just taken them.
          const contact = await tx.user.findFirst({
            where: { OR: [{ email: dto.email }, { phone: dto.phone }] }, select: { id: true },
          });
          if (contact) throw new ConflictException('The email or phone is already in use.');
          const account = await tx.user.findUnique({ where: { username }, select: { id: true } });
          if (!account) return pending;
          // Release only this uncommitted attempt before the allocator tries the next name.
          if (dto.username === undefined) await tx.dealerRegistrationRequest.delete({ where: { id: pending.id } });
          throw new UsernameTakenConflict();
        }, 'Dealer');
        const notice = {
          message: `${request.username} submitted a ${level.toLowerCase()} application.`,
          actionUrl: `/dealers?registrationRequest=${request.id}`,
          actionLabel: 'Review application',
          dedupeKey: `dealer-registration:${request.id}:submitted:${invite.parentDealerId === null ? 'admin' : 'inviter'}`,
        };
        if (invite.parentDealerId === null) {
          await this.notifications.createAndSendToRoles(['admin'], notice, { db: tx });
        } else {
          await this.notifications.createAndSend({ ...notice, recipientId: invite.parentDealerId }, tx);
        }
        return request;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      const conflict = identityConflict(error);
      if (conflict) throw conflict;
      contactConflict(error);
    }
  }

  async listPending(actor: AuthUser) {
    const parentDealerId = actorParentId(actor);
    const level = await this.level(this.prisma, parentDealerId);
    const requests = await this.prisma.dealerRegistrationRequest.findMany({
      where: { invite: { parentDealerId } }, select: pendingSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return requests.map(({ invite, ...request }) => ({
      ...request, level, estimatedMonthlySales: request.estimatedMonthlySales?.toFixed() ?? null,
      markupPercent: invite.markupPercent.toFixed(),
    }));
  }

  async review(actor: AuthUser, id: number, approve: boolean) {
    const parentDealerId = actorParentId(actor);
    if (typeof approve !== 'boolean') throw new BadRequestException('approve must be a boolean.');
    try {
      return await this.prisma.$transaction(async tx => {
        const level = await this.level(tx, parentDealerId, true);
        if (approve && parentDealerId === null) {
          // Company invitation edits take this role lock before the invitation. Creating a user also needs the role FK.
          await tx.$queryRaw`SELECT id FROM Role WHERE name = 'dealer' LOCK IN SHARE MODE`;
        }
        const locked = await tx.$queryRaw<Array<{ id: number }>>`
          SELECT r.id FROM DealerRegistrationRequest AS r
          JOIN DealerRegistrationInvite AS i ON i.id = r.inviteId
          WHERE r.id = ${id} AND i.parentDealerId <=> ${parentDealerId}
          FOR UPDATE OF r FOR SHARE OF i`;
        if (!locked.length) throw new NotFoundException('Pending request not found.');
        const request = await tx.dealerRegistrationRequest.findUnique({
          where: { id }, select: {
            ...applicantSelect, ...registrationConsentSelect, passwordHash: true,
            invite: { select: { parentDealerId: true, markupPercent: true } },
          },
        });
        if (!request || request.invite.parentDealerId !== parentDealerId) throw new NotFoundException('Pending request not found.');
        let accountId: number | null = null;
        if (approve) {
          const markup = networkMarkupFraction(request.invite.markupPercent);
          const account = await createNetworkAccount(tx, {
            username: request.username, firstName: request.firstName, lastName: request.lastName,
            email: request.email, phone: request.phone, password: request.passwordHash,
            street: request.street, addressLine2: request.addressLine2, city: request.city,
            state: request.state, postalCode: request.postalCode, companyName: request.companyName,
            estimatedMonthlySales: request.estimatedMonthlySales, yearsOfExperience: request.yearsOfExperience,
            idRole: (await this.dealerRole(tx)).id, dealerMode: 'EXTERNAL', parentDealerId,
            ...(parentDealerId === null ? { markupOverride: markup } : { networkMarkup: markup }),
            networkTaxRate: new Prisma.Decimal('0.07'),
          });
          accountId = account.id;
          await applyDealerRegistrationConsent(tx, account.id, request);
          await this.welcome.enqueue(account.id, tx, true);
          await this.notifications.createAndSend({
            recipientId: account.id, inAppOnly: true,
            message: 'Your registration was approved. Your account is now active.',
            dedupeKey: `dealer-registration:${id}:approved:applicant`,
          }, tx);
        } else {
          await this.rejections.enqueue({
            id, email: request.email, phone: request.phone,
            serviceSmsAccepted: request.serviceSmsAccepted, smsConsentVersion: request.smsConsentVersion,
            smsConsentText: request.smsConsentText, smsConsentedAt: request.smsConsentedAt,
          }, tx);
        }
        await tx.dealerRegistrationRequest.delete({ where: { id } });
        await this.logs.log({
          action: approve ? 'CREATE' : 'DELETE', entityType: approve ? 'User' : 'DealerRegistrationRequest',
          entityId: accountId ?? id, userId: actor.id,
          message: `${level} registration for ${request.username} ${approve ? 'approved' : 'rejected'}.`,
          meta: { requestId: id, parentDealerId },
        }, tx);
        return { id, approved: approve, accountId };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) { contactConflict(error); }
  }
}
