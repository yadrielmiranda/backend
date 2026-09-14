import { buildPublicEstimateData } from './public-estimate-data';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BrandingType, DealerMode, PaymentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';

import { PrismaService } from '@/prisma/prisma.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { NotificationsService } from '@/notifications/notifications.service';
import {
  estimateInstallationSummarySelect,
} from '../reporting/estimate-installation-summary';
import type { CustomerReportPricingMode } from '../dto/create-estimate-public-token.dto';
import {
  EstimateCustomerChargesService,
  isExternalDealerEstimate,
} from '../estimate-customer-charges.service';
import { attachEstimatePieceDiagramMetadata } from '../reporting/estimate-piece-diagram-metadata';

@Injectable()
export class EstimatePublicShareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly customerChargesService: EstimateCustomerChargesService,
  ) {}

  private createPublicToken(pricingMode: CustomerReportPricingMode) {
    return pricingMode === 'total' ? `total_${randomUUID()}` : randomUUID();
  }

  private getAuthUserRoleName(user: AuthUser) {
    return (user as any)?.role?.name ?? (user as any)?.roleName ?? null;
  }

  private async resolveBrandingForDealerEstimate(dealerId: number) {
    const dealerBranding = await this.prisma.branding.findFirst({
      where: {
        type: BrandingType.DEALER,
        userId: dealerId,
        isActive: true,
      },
    });

    if (dealerBranding) return dealerBranding;

    return this.prisma.branding.findFirst({
      where: {
        type: BrandingType.COMPANY,
        isActive: true,
      },
    });
  }

  async getOrCreatePublicLinkToken(
    id: number,
    user: AuthUser,
    pricingMode: CustomerReportPricingMode = 'detailed',
  ) {
    const roleName = this.getAuthUserRoleName(user);

    if (roleName !== 'dealer') {
      throw new BadRequestException(
        'Only dealers can create customer share links.',
      );
    }

    const estimate = await this.prisma.estimate.findUnique({
      where: { id },
      select: {
        id: true,
        idUser: true,
        publicToken: true,
        publicTotalToken: true,
        publicTokenEnabled: true,
        dealerModeSnapshot: true,
        order: { select: { id: true } },
        payments: {
          where: {
            OR: [
              { status: PaymentStatus.PAID },
              { stripeSessionId: { not: null } },
            ],
          },
          select: { id: true },
          take: 1,
        },
        status: {
          select: {
            name: true,
          },
        },
        user: {
          select: {
            dealerMode: true,
            role: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });

    if (!estimate || estimate.idUser !== user.id) {
      throw new NotFoundException(`Estimate with ID #${id} not found.`);
    }

    if (estimate.user.role.name !== 'dealer') {
      throw new BadRequestException(
        'Only dealer estimates can be shared with customers.',
      );
    }

    if (!['Active', 'Ordered'].includes(estimate.status?.name ?? '')) {
      throw new BadRequestException(
        'Only active or ordered estimates can be shared with customers.',
      );
    }

    const currentDealerMode = estimate.user.dealerMode ?? DealerMode.EXTERNAL;
    const classificationChanged =
      estimate.dealerModeSnapshot !== currentDealerMode;

    if (
      estimate.status?.name === 'Active' &&
      !estimate.order &&
      classificationChanged
    ) {
      if (estimate.payments.length > 0) {
        throw new BadRequestException(
          'Cancel or reconcile the checkout created under the previous dealer mode before generating the customer payment link.',
        );
      }

      await this.prisma.estimate.update({
        where: { id },
        data: {
          dealerModeSnapshot: currentDealerMode,
        },
      });
    }

    const existingToken =
      pricingMode === 'total'
        ? estimate.publicTotalToken
        : estimate.publicToken;

    if (existingToken) {
      return {
        token: existingToken,
        enabled: estimate.publicTokenEnabled,
        pricingMode,
      };
    }

    const updated = await this.prisma.estimate.update({
      where: { id },
      data:
        pricingMode === 'total'
          ? {
              publicTotalToken: this.createPublicToken('total'),
              publicTokenEnabled: true,
              publicTokenCreatedAt: new Date(),
            }
          : {
              publicToken: this.createPublicToken('detailed'),
              publicTokenEnabled: true,
              publicTokenCreatedAt: new Date(),
            },
      select: {
        publicToken: true,
        publicTotalToken: true,
        publicTokenEnabled: true,
      },
    });

    return {
      token:
        pricingMode === 'total'
          ? updated.publicTotalToken
          : updated.publicToken,
      enabled: updated.publicTokenEnabled,
      pricingMode,
    };
  }

  async findPublicEstimateByToken(token: string) {
    const normalizedToken = String(token ?? '').trim();

    if (!normalizedToken || normalizedToken.length > 64) {
      throw new NotFoundException('Estimate not found.');
    }

    const estimate = await this.prisma.estimate.findFirst({
      where: {
        publicTokenEnabled: true,
        OR: [
          { publicToken: normalizedToken },
          { publicTotalToken: normalizedToken },
        ],
      },
      include: {
        payments: { select: { status: true } },
        user: {
          include: {
            role: true,
          },
        },
        status: true,
        installationJob: {
          select: estimateInstallationSummarySelect,
        },
        customerCharges: {
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
        pieces: {
          orderBy: { id: 'asc' },
          include: {
            prod: true,
            bran: true,
            syst: true,
            conf: true,
            fColor: true,
            cryst: true,
            tin: true,
            coat: true,
            privacyOption: true,

            activeOption: true,
            preparationOption: true,
            sillOption: true,
            reinforcementOption: true,

            pieceMuntin: {
              include: {
                pattern: true,
                type: true,
                panels: {
                  orderBy: { panelIndex: 'asc' },
                },
              },
            },
          },
        },
      },
    });

    if (!estimate || estimate.user.role.name !== 'dealer') {
      throw new NotFoundException('Estimate not found.');
    }

    const pricingMode: CustomerReportPricingMode =
      estimate.publicTotalToken === normalizedToken ? 'total' : 'detailed';
    await this.notifyDealerPublicEstimateViewed(estimate);
    const [branding, pieces] = await Promise.all([
      this.resolveBrandingForDealerEstimate(estimate.idUser),
      attachEstimatePieceDiagramMetadata(this.prisma, estimate.pieces),
    ]);
    return buildPublicEstimateData(estimate, branding, pieces, pricingMode);
  }

  private buildCustomerDisplayName(estimate: {
    name: string;
    customerFirstName?: string | null;
    customerLastName?: string | null;
  }) {
    const fullName = [estimate.customerFirstName, estimate.customerLastName]
      .filter(Boolean)
      .join(' ')
      .trim();

    return fullName || estimate.name || 'Your customer';
  }

  private async notifyDealerPublicEstimateViewed(estimate: {
    id: number;
    idUser: number;
    number: string;
    name: string;
    customerFirstName?: string | null;
    customerLastName?: string | null;
  }) {
    const customerName = this.buildCustomerDisplayName(estimate);

    const message = `Customer ${customerName} is reviewing estimate #${estimate.number}.`;

    // comentario en español: evitamos notificaciones repetidas si el cliente refresca varias veces.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const recentNotification = await this.prisma.notification.findFirst({
      where: {
        recipientId: estimate.idUser,
        message,
        createdAt: {
          gte: fiveMinutesAgo,
        },
      },
      select: {
        id: true,
      },
    });

    if (recentNotification) return;

    await this.notificationsService.createAndSend({
      recipientId: estimate.idUser,
      message,
      actionUrl: `/estimates/${estimate.id}?view=public`,
      actionLabel: 'Open customer view',
    });
  }
}
