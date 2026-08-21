import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BrandingType,
  DealerAffiliation,
  DealerMode,
  PaymentStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';

import { PrismaService } from '@/prisma/prisma.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { NotificationsService } from '@/notifications/notifications.service';
import {
  buildEstimateInstallationSummary,
  estimateInstallationSummarySelect,
} from '../reporting/estimate-installation-summary';
import type { CustomerReportPricingMode } from '../dto/create-estimate-public-token.dto';

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

@Injectable()
export class EstimatePublicShareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
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
        dealerAffiliationSnapshot: true,
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
            dealerAffiliation: true,
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
    const currentDealerAffiliation =
      estimate.user.dealerAffiliation ?? DealerAffiliation.AUTHENTIC;
    const classificationChanged =
      estimate.dealerModeSnapshot !== currentDealerMode ||
      estimate.dealerAffiliationSnapshot !== currentDealerAffiliation;

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
          dealerAffiliationSnapshot: currentDealerAffiliation,
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
        user: {
          include: {
            role: true,
          },
        },
        status: true,
        installationJob: {
          select: estimateInstallationSummarySelect,
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

    const branding = await this.resolveBrandingForDealerEstimate(
      estimate.idUser,
    );

    const fullInstallationSummary = buildEstimateInstallationSummary(
      estimate.installationJob,
    );
    const publicProjectTotalIncomplete = Boolean(
      fullInstallationSummary &&
        (fullInstallationSummary.installationTotal == null ||
          (fullInstallationSummary.permitIncluded &&
            fullInstallationSummary.cityFee == null)),
    );
    const publicProjectTotal = roundMoney(
      numberValue(estimate.customerTotalPayable) +
        numberValue(fullInstallationSummary?.installationTotal) +
        (fullInstallationSummary?.permitIncluded
          ? numberValue(fullInstallationSummary.permitFee)
          : 0) +
        numberValue(fullInstallationSummary?.cityFee),
    );
    const installationSummary =
      pricingMode === 'total' && fullInstallationSummary
        ? {
            ...fullInstallationSummary,
            installationAmount:
              fullInstallationSummary.installationAmount == null
                ? null
                : '0.00',
            installationTotal:
              fullInstallationSummary.installationTotal == null ? null : '0.00',
            additionalServices: fullInstallationSummary.additionalServices.map(
              (service) => ({
                ...service,
                amount: '0.00',
              }),
            ),
            permitFee:
              fullInstallationSummary.permitFee == null ? null : '0.00',
            cityFee: fullInstallationSummary.cityFee == null ? null : '0.00',
          }
        : fullInstallationSummary;

    return {
      id: estimate.id,
      number: estimate.number,
      name: estimate.name,
      date: estimate.date,
      expiresAt: estimate.expiresAt,
      status: estimate.status,

      customerFirstName: estimate.customerFirstName,
      customerLastName: estimate.customerLastName,
      customerEmail: estimate.customerEmail,
      customerPhone: estimate.customerPhone,
      customerStreet: estimate.customerStreet,
      customerCity: estimate.customerCity,
      customerState: estimate.customerState,
      customerPostalCode: estimate.customerPostalCode,

      customerPriceT: pricingMode === 'total' ? 0 : estimate.customerPriceT,
      customerTaxRate: pricingMode === 'total' ? 0 : estimate.customerTaxRate,
      customerTaxAmount:
        pricingMode === 'total' ? 0 : estimate.customerTaxAmount,
      customerTotalPayable:
        pricingMode === 'total' ? 0 : estimate.customerTotalPayable,

      installationSummary,
      publicPricingMode: pricingMode,
      publicProjectTotal:
        pricingMode === 'total' ? publicProjectTotal : undefined,
      publicProjectTotalIncomplete:
        pricingMode === 'total' ? publicProjectTotalIncomplete : undefined,

      branding,

      pieces: estimate.pieces.map((p) => ({
        id: p.id,
        mark: p.mark,
        qty: p.qty,

        width: p.width,
        height: p.height,
        heightLeft: p.heightLeft,
        heightRight: p.heightRight,
        legHeight: p.legHeight,

        doorWidth: p.doorWidth,
        leftSideliteWidth: p.leftSideliteWidth,
        rightSideliteWidth: p.rightSideliteWidth,
        leftPanels: p.leftPanels,
        rightPanels: p.rightPanels,
        panelCount: p.panelCount,
        horizontalHeights: p.horizontalHeights,

        idProd: p.idProd,
        idBrand: p.idBrand,
        idSyst: p.idSyst,
        idConf: p.idConf,
        idFC: p.idFC,
        idCryst: p.idCryst,
        idTint: p.idTint,
        idCoat: p.idCoat,
        idPrivacy: p.idPrivacy,

        screen: p.screen,

        dpPosPsf: p.dpPosPsf,
        dpNegPsf: p.dpNegPsf,

        customerPrice: pricingMode === 'total' ? 0 : p.customerPrice,
        customerSubtotal: pricingMode === 'total' ? 0 : p.customerSubtotal,

        prod: p.prod,
        bran: p.bran,
        syst: p.syst,
        conf: p.conf,
        fColor: p.fColor,
        cryst: p.cryst,
        tin: p.tin,
        coat: p.coat,
        privacyOption: p.privacyOption,

        activeOption: p.activeOption,
        preparationOption: p.preparationOption,
        sillOption: p.sillOption,
        reinforcementOption: p.reinforcementOption,

        pieceMuntin: p.pieceMuntin,
      })),
    };
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
