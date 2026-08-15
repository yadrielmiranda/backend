import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BrandingType } from '@prisma/client';
import { randomUUID } from 'crypto';

import { PrismaService } from '@/prisma/prisma.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { NotificationsService } from '@/notifications/notifications.service';

@Injectable()
export class EstimatePublicShareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) { }

  private createPublicToken() {
    return randomUUID();
  }

  private getAuthUserRoleName(user: AuthUser) {
    return (
      (user as any)?.role?.name ??
      (user as any)?.roleName ??
      null
    );
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

  async getOrCreatePublicLinkToken(id: number, user: AuthUser) {
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
        publicTokenEnabled: true,
        status: {
          select: {
            name: true,
          },
        },
        user: {
          select: {
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

    if (estimate.status?.name !== 'Active') {
      throw new BadRequestException(
        'Only active estimates can be shared with customers.',
      );
    }

    if (estimate.publicToken) {
      return {
        token: estimate.publicToken,
        enabled: estimate.publicTokenEnabled,
      };
    }

    const updated = await this.prisma.estimate.update({
      where: { id },
      data: {
        publicToken: this.createPublicToken(),
        publicTokenEnabled: true,
        publicTokenCreatedAt: new Date(),
      },
      select: {
        publicToken: true,
        publicTokenEnabled: true,
      },
    });

    return {
      token: updated.publicToken,
      enabled: updated.publicTokenEnabled,
    };
  }

  async findPublicEstimateByToken(token: string) {
    const normalizedToken = String(token ?? '').trim();

    if (!normalizedToken || normalizedToken.length > 64) {
      throw new NotFoundException('Estimate not found.');
    }

    const estimate = await this.prisma.estimate.findFirst({
      where: {
        publicToken: normalizedToken,
        publicTokenEnabled: true,
      },
      include: {
        user: {
          include: {
            role: true,
          },
        },
        status: true,
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

    await this.notifyDealerPublicEstimateViewed(estimate);

    const branding = await this.resolveBrandingForDealerEstimate(
      estimate.idUser,
    );

    return {
      id: estimate.id,
      number: estimate.number,
      name: estimate.name,
      date: estimate.date,
      expiresAt: estimate.expiresAt,

      customerFirstName: estimate.customerFirstName,
      customerLastName: estimate.customerLastName,
      customerEmail: estimate.customerEmail,
      customerPhone: estimate.customerPhone,
      customerStreet: estimate.customerStreet,
      customerCity: estimate.customerCity,
      customerState: estimate.customerState,
      customerPostalCode: estimate.customerPostalCode,

      customerPriceT: estimate.customerPriceT,
      customerTaxRate: estimate.customerTaxRate,
      customerTaxAmount: estimate.customerTaxAmount,
      customerTotalPayable: estimate.customerTotalPayable,

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

        customerPrice: p.customerPrice,
        customerSubtotal: p.customerSubtotal,

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
    const fullName = [
      estimate.customerFirstName,
      estimate.customerLastName,
    ]
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
    });
  }
}
