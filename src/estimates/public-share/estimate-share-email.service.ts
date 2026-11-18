import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { BrandingType } from '@prisma/client';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { ContractsService } from '@/contracts/contracts.service';
import { EstimateShareEmailRejectedException, NotificationEmailService, type EstimateShareEmail, type EstimateShareEmailResult } from '@/notifications/notification-email.service';
import { ESTIMATE_EMAIL_RECIPIENTS_ERROR, parseEstimateEmailRecipients } from '@/notifications/estimate-email-recipients';
import { PrismaService } from '@/prisma/prisma.service';
import type { ShareEstimateEmailDto } from '../dto/share-estimate-email.dto';
import type { ShareEstimateMessageDto } from '../dto/share-estimate-message.dto';
import { EstimateShareSmsService, normalizeEstimateSmsPhone } from './estimate-share-sms.service';
import { EstimatePublicShareService } from './estimate-public-share.service';
import { canShareEstimate } from './estimate-share-access';

type EmailContext = {
  number: string | number;
  name?: string | null;
  customerFirstName?: string | null;
  customerLastName?: string | null;
  branding?: { name?: string | null; email?: string | null } | null;
};

type PreparedShare = Omit<EstimateShareEmail, 'to' | 'cc'>;
export type EstimateShareMessageResult = {
  sent: boolean;
  email?: {
    status: 'sent' | 'partial' | 'failed' | 'unknown';
    message?: string;
    accepted?: string[];
    rejected?: string[];
    unconfirmed?: string[];
  };
  sms?: { status: 'sent' | 'failed' | 'unknown'; message?: string };
};

@Injectable()
export class EstimateShareEmailService {
  private readonly sending = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicShare: EstimatePublicShareService,
    private readonly contracts: ContractsService,
    private readonly email: NotificationEmailService,
    private readonly sms: EstimateShareSmsService,
  ) {}

  async send(estimateId: number, dto: ShareEstimateEmailDto, user: AuthUser): Promise<EstimateShareEmailResult> {
    const recipients = parseEstimateEmailRecipients(dto.to, dto.cc);
    if (!recipients) throw new BadRequestException(ESTIMATE_EMAIL_RECIPIENTS_ERROR);
    return this.withPreparedShare(estimateId, dto, user,
      () => this.email.assertEstimateShareReady(),
      prepared => this.email.sendEstimateShare({
        ...prepared, to: recipients.to,
        ...(recipients.cc.length ? { cc: recipients.cc.join(', ') } : {}),
      }),
    );
  }

  async sendMessage(estimateId: number, dto: ShareEstimateMessageDto, user: AuthUser): Promise<EstimateShareMessageResult> {
    if (!['email', 'sms', 'both'].includes(dto.channel)) throw new BadRequestException('Choose Email, SMS, or both.');
    const wantsEmail = dto.channel !== 'sms';
    const wantsSms = dto.channel !== 'email';
    const recipients = wantsEmail ? parseEstimateEmailRecipients(dto.to, dto.cc) : null;
    if (wantsEmail && !recipients) throw new BadRequestException(ESTIMATE_EMAIL_RECIPIENTS_ERROR);
    const phone = wantsSms ? normalizeEstimateSmsPhone(dto.phone) : null;
    if (wantsSms && !phone) throw new BadRequestException('Enter a valid +1 mobile phone number for SMS.');
    return this.withPreparedShare(estimateId, dto, user, async () => {
      // Fail before preparing a contract or attempting either selected channel.
      try {
        if (wantsEmail) this.email.assertEstimateShareReady();
        if (wantsSms) await this.sms.assertReady(phone!);
      } catch (error) {
        if (error instanceof ServiceUnavailableException) {
          throw new ServiceUnavailableException({ message: error.message, code: 'ESTIMATE_SHARE_NOT_SENT' });
        }
        throw error;
      }
    }, async prepared => {
      const result: EstimateShareMessageResult = { sent: false };
      // The same prepared customer report is sent once to each selected channel.
      // Keep outcomes independent: an accepted delivery must not be retried just
      // because the other channel failed or its outcome could not be confirmed.
      await Promise.all([
        (async () => {
          if (!recipients) return;
          try {
            const outcome = await this.email.sendEstimateShare({
              ...prepared, to: recipients.to,
              ...(recipients.cc.length ? { cc: recipients.cc.join(', ') } : {}),
            });
            result.email = outcome.sent === true ? { status: 'sent' } : {
              status: 'partial', accepted: outcome.accepted,
              rejected: outcome.rejected, unconfirmed: outcome.unconfirmed,
            };
          } catch (error) {
            result.email = error instanceof EstimateShareEmailRejectedException
              ? { status: 'failed', message: 'The email service rejected the recipient. Check the email address before trying again.' }
              : { status: 'unknown', message: 'Email delivery could not be confirmed. Check whether it arrived before sending again.' };
          }
        })(),
        (async () => {
          if (!phone) return;
          try {
            result.sms = await this.sms.send({
              phone, path: prepared.path, estimateNumber: prepared.estimateNumber,
              customerName: prepared.customerName, ownerBrandingName: prepared.ownerBrandingName,
            });
          } catch (error) {
            // Validation/readiness exceptions happen before the provider attempt.
            result.sms = error instanceof BadRequestException || error instanceof ConflictException || error instanceof ServiceUnavailableException
              ? { status: 'failed', message: error.message }
              : { status: 'unknown', message: 'SMS delivery could not be confirmed. Check whether it arrived before sending again.' };
          }
        })(),
      ]);
      result.sent = (!wantsEmail || result.email?.status === 'sent') && (!wantsSms || result.sms?.status === 'sent');
      return result;
    });
  }

  private async withPreparedShare<T>(
    estimateId: number,
    dto: Pick<ShareEstimateEmailDto, 'pricingMode' | 'includeContract'>,
    user: AuthUser,
    assertReady: () => void | Promise<void>,
    deliver: (prepared: PreparedShare) => Promise<T>,
  ): Promise<T> {
    if (!['detailed', 'total'].includes(dto.pricingMode) || typeof dto.includeContract !== 'boolean') {
      throw new BadRequestException('Select a valid customer report and contract option.');
    }
    if (!['admin', 'dealer'].includes(user.role?.name ?? '')) {
      throw new ForbiddenException('Only administrators and internal dealers can send estimates.');
    }
    const key = `${user.id}:${estimateId}`;
    if (this.sending.has(key)) throw new ConflictException('This estimate is already being sent.');
    this.sending.add(key);
    try {
      // La clasificación pertenece al usuario que envía, no al dueño del estimado.
      const actor = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { isActive: true, deletedAt: true, dealerMode: true, role: { select: { name: true } } },
      });
      if (!actor?.isActive || actor.deletedAt ||
        !(actor.role.name === 'admin' || (actor.role.name === 'dealer' && actor.dealerMode === 'INTERNAL'))) {
        throw new ForbiddenException('Only administrators and internal dealers can send estimates.');
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
      await assertReady();
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
      return await deliver({
        path, estimateNumber: context.number,
        ownerBrandingName: context.branding?.name,
        ownerEmail: context.branding?.email,
        customerName: [context.customerFirstName, context.customerLastName].filter(Boolean).join(' '),
        projectName: context.name,
      });
    } finally {
      this.sending.delete(key);
    }
  }
}
