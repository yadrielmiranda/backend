import { Module, Controller, Get, Post, Patch, Delete, Param, ParseIntPipe, Body, Req, Injectable, ForbiddenException, BadRequestException, ConflictException, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { Request } from 'express';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaModule } from '@/prisma/prisma.module';
import { PrismaService } from '@/prisma/prisma.service';
import { LogsModule } from '@/logs/logs.module';
import { LogsService } from '@/logs/logs.service';
import { NotificationsModule } from '@/notifications/notifications.module';
import { NotificationsService } from '@/notifications/notifications.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { dealerChain, descendantIds, NETWORK_LABELS, validateSubdealerPlan, networkAccountTaxRate } from './dealer-network';
import { CreateNetworkMemberDto, SetNetworkSuspensionDto, ReviewNetworkSuspensionDto, UpdateNetworkMarkupDto } from './dealer-network.dto';
import { networkAccessBlocked, networkSalesBlocked, networkParentSelect } from './network-access';

const memberSelect = {
  id: true, username: true, firstName: true, lastName: true, email: true, phone: true,
  parentDealerId: true, networkMarkup: true, markupOverride: true, dealerMode: true, isActive: true,
  networkTaxRate: true, isTaxExempt: true,
  networkSuspended: true, networkSuspendedByAdmin: true, deletedAt: true, role: { select: { name: true, markup: true } },
  networkBusinessActions: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1,
    select: { id: true, actorId: true, actorName: true, suspended: true, reason: true,
      status: true, createdAt: true, reviewedAt: true, reviewNote: true } },
  subdealerEarningsMode: true, subdealerEarningsPercent: true,
  parentDealer: { select: { id: true, username: true, ...networkParentSelect } },
} satisfies Prisma.UserSelect;

@Injectable()
export class DealerNetworkService {
  constructor(private prisma: PrismaService, private logs: LogsService, private notifications: NotificationsService) {}

  private requireDealerOrStaff(actor: AuthUser) {
    if (!['dealer', 'admin', 'operator'].includes(actor.role?.name ?? '')) throw new ForbiddenException('Dealer network access required.');
  }

  async list(actor: AuthUser) {
    this.requireDealerOrStaff(actor);
    const staff = actor.role?.name !== 'dealer';
    const chain = staff ? null : await dealerChain(this.prisma, actor.id);
    const ids = staff ? null : await descendantIds(this.prisma, actor);
    const salesTax = await this.prisma.globalParameter.findUnique({ where: { key: 'SALES_TAX' } });
    if (!salesTax) throw new InternalServerErrorException('SALES_TAX config missing.');
    const members = await this.prisma.user.findMany({
      where: { role: { name: 'dealer' }, deletedAt: null, ...(ids ? { id: { in: ids } } : {}) },
      select: memberSelect, orderBy: [{ parentDealerId: 'asc' }, { username: 'asc' }],
    });
    return {
      canCreate: actor.role?.name === 'admin' || Boolean(chain && chain.length < 3 && !chain.some(networkSalesBlocked)),
      level: chain ? NETWORK_LABELS[chain.length - 1] : null,
      defaultTaxPercent: salesTax.value.mul(100).toString(),
      members: members.map(member => {
        const level = member.parentDealerId == null ? 1 : member.parentDealer?.parentDealerId == null ? 2 : 3;
        const canManage = actor.role?.name === 'admin' || actor.role?.name === 'dealer' && member.parentDealerId === actor.id;
        const admin = actor.role?.name === 'admin';
        const available = canManage && member.isActive && (admin || Boolean(member.parentDealer && !networkAccessBlocked(member.parentDealer)));
        const action = member.networkBusinessActions?.[0] ?? null;
        return {
          id: member.id, username: member.username, firstName: member.firstName, lastName: member.lastName,
          email: member.email, phone: member.phone, isActive: member.isActive,
          networkSuspended: member.networkSuspended, networkAccessBlocked: networkAccessBlocked(member),
          networkSalesBlocked: networkSalesBlocked(member),
          parentDealerId: member.parentDealerId, parentName: member.parentDealer?.username ?? null,
          parentDealerMode: member.parentDealer?.dealerMode ?? null,
          level, levelLabel: NETWORK_LABELS[level - 1], dealerMode: member.dealerMode,
          canSuspend: Boolean(available && (admin || member.parentDealer?.dealerMode !== 'INTERNAL' && !member.networkSuspendedByAdmin)),
          canRequestSuspension: Boolean(available && !admin && (member.parentDealer?.dealerMode === 'INTERNAL' || member.networkSuspendedByAdmin)),
          canReviewSuspension: admin && action?.status === 'PENDING',
          canWithdrawRequest: canManage && action?.status === 'PENDING' && action.actorId === actor.id,
          businessAction: canManage ? action : null,
          // En la raíz muestra el markup efectivo de Authentic; en los demás niveles, el del superior.
          canManage, ...(canManage ? { markupPercent: (member.parentDealerId == null
            ? member.markupOverride ?? member.role.markup : member.networkMarkup).mul(100).toString(),
            taxPercent: networkAccountTaxRate(member, salesTax.value.toString()).mul(100).toString(),
            subdealerEarningsMode: member.subdealerEarningsMode, subdealerEarningsPercent: member.subdealerEarningsPercent?.toString() ?? null,
          } : {}),
        };
      }),
    };
  }

  private memberTerms(chain: Awaited<ReturnType<typeof dealerChain>>, dto: Pick<CreateNetworkMemberDto, 'dealerMode' | 'subdealerEarningsMode' | 'subdealerEarningsPercent'>) {
    const dealerMode = dto.dealerMode ?? 'EXTERNAL';
    if (dealerMode === 'INTERNAL') {
      if (chain.length !== 1 || chain[0].dealerMode !== 'INTERNAL')
        throw new BadRequestException('Only an internal dealer can have internal subdealers. Distributors are always external.');
      const plan = validateSubdealerPlan(dto.subdealerEarningsMode, dto.subdealerEarningsPercent);
      return { dealerMode, subdealerEarningsMode: plan.mode, subdealerEarningsPercent: plan.percent };
    }
    return { dealerMode, subdealerEarningsMode: null, subdealerEarningsPercent: null };
  }

  async create(dto: CreateNetworkMemberDto, actor: AuthUser) {
    this.requireDealerOrStaff(actor);
    if (actor.role?.name === 'operator') throw new ForbiddenException('Only dealers and administrators can create network accounts.');
    if (actor.role?.name !== 'admin' && dto.parentDealerId != null && dto.parentDealerId !== actor.id)
      throw new ForbiddenException('You can only create accounts directly below your account.');
    const parentId = actor.role?.name === 'admin' ? dto.parentDealerId : actor.id;
    if (!parentId) throw new BadRequestException('Select the parent dealer.');
    const password = await bcrypt.hash(dto.password, 10);
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM User WHERE id = ${parentId} FOR UPDATE`;
        const chain = await dealerChain(tx, parentId);
        if (chain.length >= 3) throw new BadRequestException('Distributors cannot create another level.');
        if (chain.some(networkSalesBlocked)) throw new BadRequestException('The parent network is inactive or suspended.');
        const parent = chain.at(-1)!;
        const terms = this.memberTerms(chain, dto);
        const account = await tx.user.create({ data: {
          username: dto.username, firstName: dto.firstName, lastName: dto.lastName,
          email: dto.email, phone: dto.phone, password,
          street: dto.street, city: dto.city, state: dto.state, postalCode: dto.postalCode,
          idRole: parent.idRole, ...terms, parentDealerId: parent.id,
          networkMarkup: new Prisma.Decimal(dto.markupPercent).div(100),
          ...(dto.taxPercent != null ? { networkTaxRate: new Prisma.Decimal(dto.taxPercent).div(100) } : {}),
          // Las exenciones fiscales y de depósito siguen bajo control de administración.
          isTaxExempt: false, noInstallationDeposit: false,
        }, select: { id: true, username: true, parentDealerId: true } });
        await this.logs.log({ action: 'CREATE', entityType: 'User', entityId: account.id, userId: actor.id,
          message: `${NETWORK_LABELS[chain.length]} ${account.username} created under ${parent.username}.`,
          after: { ...account, networkMarkup: new Prisma.Decimal(dto.markupPercent).div(100).toString(),
            networkTaxRate: dto.taxPercent != null ? new Prisma.Decimal(dto.taxPercent).div(100).toString() : null, ...terms },
          meta: { source: 'DealerNetworkService.create' },
        }, tx);
        return account;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException('The username, email or phone is already in use.');
      throw error;
    }
  }

  async updateMarkup(id: number, dto: UpdateNetworkMarkupDto, actor: AuthUser) {
    this.requireDealerOrStaff(actor);
    if (actor.role?.name === 'operator') throw new ForbiddenException('Only dealers and administrators can edit network terms.');
    const member = await this.prisma.user.findUnique({ where: { id }, select: memberSelect });
    if (!member?.parentDealerId || member.deletedAt || member.parentDealerId !== actor.id && actor.role?.name !== 'admin')
      throw new NotFoundException('Direct network account not found.');
    return this.prisma.$transaction(async tx => {
      // Comparte el bloqueo del superior con los cambios administrativos de su tipo.
      await tx.$queryRaw`SELECT id FROM User WHERE id = ${member.parentDealerId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM User WHERE id = ${id} FOR UPDATE`;
      const account = await tx.user.findUnique({ where: { id }, select: memberSelect });
      if (!account?.parentDealerId || account.deletedAt || account.parentDealerId !== member.parentDealerId || account.parentDealerId !== actor.id && actor.role?.name !== 'admin')
        throw new NotFoundException('Direct network account not found.');
      const chain = await dealerChain(tx, account.parentDealerId);
      if (actor.role?.name !== 'admin' && chain.some(networkAccessBlocked)) throw new ForbiddenException('The parent network is inactive or suspended.');
      const terms = this.memberTerms(chain, {
        dealerMode: dto.dealerMode ?? account.dealerMode ?? 'EXTERNAL',
        subdealerEarningsMode: dto.subdealerEarningsMode ?? account.subdealerEarningsMode ?? undefined,
        subdealerEarningsPercent: dto.subdealerEarningsPercent ?? account.subdealerEarningsPercent?.toNumber(),
      });
      const networkTaxRate = dto.taxPercent != null ? new Prisma.Decimal(dto.taxPercent).div(100) : account.networkTaxRate;
      const updated = await tx.user.update({ where: { id }, data: { ...terms, networkMarkup: new Prisma.Decimal(dto.markupPercent).div(100),
        ...(dto.taxPercent != null ? { networkTaxRate } : {}),
      }, select: { id: true } });
      await this.logs.log({ action: 'UPDATE', entityType: 'User', entityId: id, userId: actor.id,
        message: `Network account terms updated for ${account.username}.`,
        before: { networkMarkup: account.networkMarkup.toString(), networkTaxRate: account.networkTaxRate?.toString() ?? null,
          dealerMode: account.dealerMode, subdealerEarningsMode: account.subdealerEarningsMode, subdealerEarningsPercent: account.subdealerEarningsPercent?.toString() },
        after: { networkMarkup: new Prisma.Decimal(dto.markupPercent).div(100).toString(), networkTaxRate: networkTaxRate?.toString() ?? null, ...terms },
        meta: { source: 'DealerNetworkService.updateMarkup' },
      }, tx);
      return updated;
    });
  }

  private reason(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 500)
      throw new BadRequestException('Enter an internal reason between 3 and 500 characters.');
    return value.trim();
  }

  private async withManagedAccount<T>(id: number, actor: AuthUser, work: (
    tx: Prisma.TransactionClient, account: Prisma.UserGetPayload<{ select: typeof memberSelect }>,
    chain: Awaited<ReturnType<typeof dealerChain>>,
  ) => Promise<T>): Promise<T> {
    this.requireDealerOrStaff(actor);
    if (actor.role?.name === 'operator') throw new ForbiddenException('Only dealers and administrators can manage new business.');
    const member = await this.prisma.user.findUnique({ where: { id }, select: memberSelect });
    if (id === actor.id || !member || member.role.name !== 'dealer' || member.deletedAt ||
        member.parentDealerId !== actor.id && actor.role?.name !== 'admin')
      throw new NotFoundException('Direct network account not found.');
    return this.prisma.$transaction(async tx => {
      // Conserva el orden de bloqueo usado al crear cuentas y editar condiciones.
      if (member.parentDealerId != null) await tx.$queryRaw`SELECT id FROM User WHERE id = ${member.parentDealerId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM User WHERE id = ${id} FOR UPDATE`;
      const account = await tx.user.findUnique({ where: { id }, select: memberSelect });
      if (!account || account.role.name !== 'dealer' || account.deletedAt || account.parentDealerId !== member.parentDealerId ||
          account.parentDealerId !== actor.id && actor.role?.name !== 'admin')
        throw new NotFoundException('Direct network account not found.');
      const chain = account.parentDealerId == null ? [] : await dealerChain(tx, account.parentDealerId);
      if (actor.role?.name !== 'admin' && chain.some(networkAccessBlocked))
        throw new ForbiddenException('The parent network is inactive or suspended.');
      return work(tx, account, chain);
    });
  }

  private async applySuspension(tx: Prisma.TransactionClient,
    account: Prisma.UserGetPayload<{ select: typeof memberSelect }>, suspended: boolean,
    actor: AuthUser, reason: string, requestId?: number,
  ) {
    if (!account.isActive) throw new ForbiddenException('This account was deactivated by an administrator.');
    const now = new Date();
    // Una decisión posterior invalida solicitudes previas; nunca se pueden aprobar desde una pantalla vieja.
    await tx.networkBusinessAction.updateMany({ where: { accountId: account.id, activeSlot: 1,
      ...(requestId ? { id: { not: requestId } } : {}) },
      data: { status: 'SUPERSEDED', activeSlot: null, reviewedAt: now, reviewedById: actor.id } });
    if (requestId) await tx.networkBusinessAction.update({ where: { id: requestId }, data: {
      status: 'APPLIED', activeSlot: null, reviewedById: actor.id, reviewedAt: now, reviewNote: reason,
    } });
    else await tx.networkBusinessAction.create({ data: {
      accountId: account.id, actorId: actor.id, actorName: actor.username ?? `${actor.role?.name} #${actor.id}`,
      suspended, reason, status: 'APPLIED', reviewedAt: now,
      reviewedById: actor.role?.name === 'admin' ? actor.id : null,
    } });
    const updated = await tx.user.update({ where: { id: account.id }, data: {
      networkSuspended: suspended, networkSuspendedByAdmin: suspended && actor.role?.name === 'admin',
    }, select: { id: true, networkSuspended: true } });
    const affectedIds = await descendantIds(tx, { id: account.id, role: { name: 'dealer' } } as AuthUser);
    await this.logs.log({ action: 'UPDATE', entityType: 'User', entityId: account.id, userId: actor.id,
      message: `New business ${suspended ? 'paused' : 'resumed'} for ${account.username}. ${reason}`,
      before: { networkSuspended: account.networkSuspended }, after: { networkSuspended: suspended },
      meta: { source: 'DealerNetworkService.setSuspension', affectedAccountIds: affectedIds, requestId },
    }, tx);
    return updated;
  }

  async setSuspension(id: number, suspended: boolean, actor: AuthUser, reason: string) {
    if (typeof suspended !== 'boolean') throw new BadRequestException('suspended must be a boolean.');
    return this.withManagedAccount(id, actor, async (tx, account, chain) => {
      const note = this.reason(reason);
      if (!account.isActive) throw new ForbiddenException('This account was deactivated by an administrator.');
      if (actor.role?.name !== 'admin' && (chain.at(-1)?.dealerMode === 'INTERNAL' || account.networkSuspendedByAdmin))
        throw new ForbiddenException('Request administrative approval to change new business for this account.');
      if (account.networkSuspended === suspended) return { id, networkSuspended: suspended };
      const result = await this.applySuspension(tx, account, suspended, actor, note);
      if (actor.role?.name !== 'admin') await this.notifications.createAndSendToRoles(['admin'], {
        actorId: actor.id, message: `${actor.username ?? 'Dealer'} ${suspended ? 'paused' : 'resumed'} new business for ${account.username}.`,
        actionUrl: '/dealers', actionLabel: 'View dealer network',
      }, { db: tx });
      return result;
    });
  }

  async requestSuspension(id: number, suspended: boolean, actor: AuthUser, reason: string) {
    if (actor.role?.name !== 'dealer') throw new ForbiddenException('Only the direct dealer can submit this request.');
    if (typeof suspended !== 'boolean') throw new BadRequestException('suspended must be a boolean.');
    return this.withManagedAccount(id, actor, async (tx, account, chain) => {
      const note = this.reason(reason);
      if (!account.isActive) throw new ForbiddenException('This account was deactivated by an administrator.');
      if (chain.at(-1)?.dealerMode !== 'INTERNAL' && !account.networkSuspendedByAdmin)
        throw new BadRequestException('This external dealer can change new business directly.');
      if (account.networkSuspended === suspended) throw new ConflictException('The account already has this business status.');
      const pending = await tx.networkBusinessAction.findFirst({ where: { accountId: id, activeSlot: 1 } });
      if (pending) throw new ConflictException('An administrative request is already pending.');
      const request = await tx.networkBusinessAction.create({ data: {
        accountId: id, actorId: actor.id, actorName: actor.username ?? chain.at(-1)!.username,
        suspended, reason: note, status: 'PENDING', activeSlot: 1,
      } });
      await this.logs.log({ action: 'CREATE', entityType: 'NetworkBusinessAction', entityId: request.id, userId: actor.id,
        message: `Requested ${suspended ? 'pause' : 'resumption'} of new business for ${account.username}. ${note}`,
      }, tx);
      await this.notifications.createAndSendToRoles(['admin'], {
        actorId: actor.id, message: `${request.actorName} requested ${suspended ? 'a pause' : 'resumption'} of new business for ${account.username}.`,
        actionUrl: '/dealers', actionLabel: 'Review request', dedupeKey: `network-business:${request.id}:requested`,
      }, { db: tx });
      return { id: request.id, status: request.status };
    });
  }

  async reviewSuspension(requestId: number, approve: boolean, actor: AuthUser, reason?: string) {
    if (actor.role?.name !== 'admin') throw new ForbiddenException('Only administrators can review these requests.');
    if (typeof approve !== 'boolean') throw new BadRequestException('approve must be a boolean.');
    const initial = await this.prisma.networkBusinessAction.findUnique({ where: { id: requestId } });
    if (!initial) throw new NotFoundException('Request not found.');
    return this.withManagedAccount(initial.accountId, actor, async (tx, account) => {
      const request = await tx.networkBusinessAction.findUnique({ where: { id: requestId } });
      if (!request || request.activeSlot !== 1 || request.status !== 'PENDING') throw new ConflictException('This request is no longer pending.');
      const note = this.reason(approve && !reason?.trim() ? request.reason : reason);
      if (approve) await this.applySuspension(tx, account, request.suspended, actor, note, requestId);
      else await tx.networkBusinessAction.update({ where: { id: requestId }, data: {
        status: 'REJECTED', activeSlot: null, reviewedById: actor.id, reviewedAt: new Date(), reviewNote: note,
      } });
      await this.logs.log({ action: 'UPDATE', entityType: 'NetworkBusinessAction', entityId: requestId, userId: actor.id,
        message: `Request for ${account.username} ${approve ? 'approved' : 'declined'}. ${note}`,
      }, tx);
      if (request.actorId) await this.notifications.createAndSend({ recipientId: request.actorId, actorId: actor.id,
        message: `Your request to ${request.suspended ? 'pause' : 'resume'} new business for ${account.username} was ${approve ? 'approved' : 'declined'}.`,
        actionUrl: '/dealers', actionLabel: 'View dealer network', dedupeKey: `network-business:${requestId}:reviewed`,
      }, tx);
      return { id: requestId, status: approve ? 'APPLIED' : 'REJECTED' };
    });
  }

  async withdrawSuspension(requestId: number, actor: AuthUser) {
    const initial = await this.prisma.networkBusinessAction.findUnique({ where: { id: requestId } });
    if (!initial || initial.actorId !== actor.id) throw new NotFoundException('Request not found.');
    return this.withManagedAccount(initial.accountId, actor, async (tx) => {
      const request = await tx.networkBusinessAction.findUnique({ where: { id: requestId } });
      if (!request || request.actorId !== actor.id || request.activeSlot !== 1 || request.status !== 'PENDING')
        throw new ConflictException('This request is no longer pending.');
      await tx.networkBusinessAction.update({ where: { id: requestId }, data: {
        status: 'WITHDRAWN', activeSlot: null, reviewedAt: new Date(),
      } });
      await this.logs.log({ action: 'UPDATE', entityType: 'NetworkBusinessAction', entityId: requestId,
        userId: actor.id, message: 'New business request withdrawn by its author.' }, tx);
      return { id: requestId, status: 'WITHDRAWN' };
    });
  }
}

@Controller('dealer-network')
export class DealerNetworkController {
  constructor(private service: DealerNetworkService) {}
  @Get() list(@Req() req: Request) { return this.service.list(req.user as AuthUser); }
  @Post() create(@Body() dto: CreateNetworkMemberDto, @Req() req: Request) { return this.service.create(dto, req.user as AuthUser); }
  @Patch(':id/markup') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateNetworkMarkupDto, @Req() req: Request) {
    return this.service.updateMarkup(id, dto, req.user as AuthUser);
  }
  @Patch(':id/suspension') setSuspension(@Param('id', ParseIntPipe) id: number, @Body() dto: SetNetworkSuspensionDto, @Req() req: Request) {
    return this.service.setSuspension(id, dto.suspended, req.user as AuthUser, dto.reason);
  }
  @Post(':id/suspension-requests') requestSuspension(@Param('id', ParseIntPipe) id: number, @Body() dto: SetNetworkSuspensionDto, @Req() req: Request) {
    return this.service.requestSuspension(id, dto.suspended, req.user as AuthUser, dto.reason);
  }
  @Patch('suspension-requests/:requestId') reviewSuspension(@Param('requestId', ParseIntPipe) id: number, @Body() dto: ReviewNetworkSuspensionDto, @Req() req: Request) {
    return this.service.reviewSuspension(id, dto.approve, req.user as AuthUser, dto.reason);
  }
  @Delete('suspension-requests/:requestId') withdrawSuspension(@Param('requestId', ParseIntPipe) id: number, @Req() req: Request) {
    return this.service.withdrawSuspension(id, req.user as AuthUser);
  }
}

@Module({ imports: [PrismaModule, LogsModule, NotificationsModule], controllers: [DealerNetworkController], providers: [DealerNetworkService] })
export class DealerNetworkModule {}
