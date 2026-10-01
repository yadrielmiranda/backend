import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BrandingType } from '@prisma/client';
import { isEmail } from 'class-validator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { ContractsService } from '@/contracts/contracts.service';
import { NotificationEmailService } from '@/notifications/notification-email.service';
import { PrismaService } from '@/prisma/prisma.service';
import type { ShareEstimateEmailDto } from '../dto/share-estimate-email.dto';
import { EstimatePublicShareService } from './estimate-public-share.service';
import { canShareEstimate } from './estimate-share-access';

type EmailContext = {
  number: string | number;
  name?: string | null;
  customerFirstName?: string | null;
  customerLastName?: string | null;
  branding?: { name?: string | null; email?: string | null } | null;
};

@Injectable()
export class EstimateShareEmailService {
  private readonly sending = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicShare: EstimatePublicShareService,
    private readonly contracts: ContractsService,
    private readonly email: NotificationEmailService,
  ) {}

  async send(estimateId: number, dto: ShareEstimateEmailDto, user: AuthUser) {
    const to = typeof dto.to === 'string' ? dto.to.trim() : '';
    if (!isEmail(to) || to.length > 254 ||
      !['detailed', 'total'].includes(dto.pricingMode) || typeof dto.includeContract !== 'boolean') {
      throw new BadRequestException('Enter a valid email address and customer report.');
    }
    if (!['admin', 'dealer'].includes(user.role?.name ?? '')) {
      throw new ForbiddenException('Only administrators and internal dealers can send estimates by email.');
    }
    const key = `${user.id}:${estimateId}`;
    if (this.sending.has(key)) throw new ConflictException('This estimate email is already being sent.');
    this.sending.add(key);
    try {
      // La clasificación pertenece al usuario que envía, no al dueño del estimado.
      const actor = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { isActive: true, deletedAt: true, dealerMode: true, role: { select: { name: true } } },
      });
      if (!actor?.isActive || actor.deletedAt ||
        !(actor.role.name === 'admin' || (actor.role.name === 'dealer' && actor.dealerMode === 'INTERNAL'))) {
        throw new ForbiddenException('Only administrators and internal dealers can send estimates by email.');
      }
      const sender: AuthUser = { ...user, role: { name: actor.role.name === 'admin' ? 'admin' : 'dealer' } };
      const estimate = await this.prisma.estimate.findUnique({
        where: { id: estimateId },
        select: {
          id: true, idUser: true, number: true, name: true,
          customerFirstName: true, customerLastName: true,
          publicToken: true, publicTotalToken: true, publicTokenEnabled: true,
          user: { select: { isActive: true, deletedAt: true, role: { select: { name: true } } } },
        },
      });
      if (!await canShareEstimate(this.prisma, estimate, sender)) {
        throw new NotFoundException('Estimate not found.');
      }
      if (!estimate.user.isActive || estimate.user.deletedAt) {
        throw new BadRequestException('The estimate owner account is inactive.');
      }
      if ((estimate.publicToken || estimate.publicTotalToken) && !estimate.publicTokenEnabled) {
        throw new BadRequestException('The customer link is disabled.');
      }
      // Fallar antes de preparar documentos si no hay correo configurado.
      this.email.assertEstimateShareReady();
      const shared = await this.publicShare.getOrCreatePublicLinkToken(estimateId, sender, dto.pricingMode);
      if (!shared.token || !shared.enabled) throw new BadRequestException('The customer link is disabled.');
      let path = `/public/estimates/${encodeURIComponent(shared.token)}`;
      let context: EmailContext;
      if (dto.includeContract) {
        const prepared = await this.contracts.prepare(estimateId, dto.pricingMode, true, sender);
        if (!prepared.current) {
          throw new BadRequestException('The estimate owner must upload a contract before including it.');
        }
        const agreement = await this.prisma.estimateAgreement.findFirst({
          where: { id: prepared.current.id, estimateId, pricingMode: dto.pricingMode, invalidatedAt: null },
          select: { snapshot: true, quoteFileKey: true },
        });
        if (!agreement?.quoteFileKey) {
          throw new ConflictException('The agreement is not ready or the estimate changed. Please try again.');
        }
        // El correo y el enlace usan la misma copia y marca del propietario.
        context = agreement.snapshot as unknown as EmailContext;
        path += `/agreements/${encodeURIComponent(prepared.current.id)}`;
      } else {
        const branding = await this.prisma.branding.findFirst({
          where: { type: BrandingType.DEALER, userId: estimate.idUser, isActive: true },
          select: { name: true, email: true },
        }) ?? await this.prisma.branding.findFirst({
          where: { type: BrandingType.COMPANY, isActive: true },
          select: { name: true, email: true },
        });
        context = { ...estimate, branding };
      }
      await this.email.sendEstimateShare({
        to, path, estimateNumber: context.number,
        ownerBrandingName: context.branding?.name,
        ownerEmail: context.branding?.email,
        customerName: [context.customerFirstName, context.customerLastName].filter(Boolean).join(' '),
        projectName: context.name,
      });
      return { sent: true as const };
    } finally {
      this.sending.delete(key);
    }
  }
}
