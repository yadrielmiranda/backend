import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { PromotionTerms, promotionTerms } from './promotion-pricing';
import { PromotionDto } from './promotions.dto';
import Decimal from 'decimal.js';

const ids = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.filter((id) => Number.isInteger(id) && id > 0)
    : [];
@Injectable()
export class PromotionsService {
  constructor(private prisma: PrismaService) {}
  async eligible(
    userId: number,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<PromotionTerms[]> {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { idRole: true, role: { select: { name: true } } },
    });
    const now = new Date();
    const rows = await tx.promotion.findMany({
      where: { enabled: true, startsAt: { lte: now }, endsAt: { gt: now } },
    });
    const directlyEligible = (p: (typeof rows)[number]) =>
      p.audience === 'ALL' ||
      (p.audience === 'ROLE' &&
        Array.isArray(p.roleIds) &&
        p.roleIds.includes(user.idRole)) ||
      (p.audience === 'USERS' &&
        Array.isArray(p.userIds) &&
        p.userIds.includes(userId));
    const clientRole =
      user.role.name === 'dealer'
        ? await tx.role.findUnique({
            where: { name: 'client' },
            select: { id: true, markup: true },
          })
        : null;
    const selectedIds = clientRole
      ? [
          ...new Set(
            rows
              .filter((p) => p.audience === 'USERS' && !directlyEligible(p))
              .flatMap((p) => ids(p.userIds)),
          ),
        ]
      : [];
    const selectedUsers = selectedIds.length
      ? await tx.user.findMany({
          where: { id: { in: selectedIds }, deletedAt: null },
          select: { id: true, idRole: true, markupOverride: true },
        })
      : [];
    const candidates = rows.flatMap(
      (p): { promotion: typeof p; clientReferenceMarkup?: string }[] => {
        if (directlyEligible(p)) return [{ promotion: p }];
        if (!clientRole) return [];
        if (
          p.audience === 'ROLE' &&
          ids(p.roleIds).includes(clientRole.id) &&
          !ids(p.roleIds).includes(user.idRole)
        ) {
          return [
            {
              promotion: p,
              clientReferenceMarkup: clientRole.markup.toString(),
            },
          ];
        }
        if (p.audience === 'USERS') {
          const targets = ids(p.userIds);
          const clients = selectedUsers.filter((u) => targets.includes(u.id));
          // Una oferta privada solo origina el ajuste si todos sus destinatarios son clients.
          if (
            targets.length &&
            clients.length === targets.length &&
            clients.every((u) => u.idRole === clientRole.id)
          ) {
            return [
              {
                promotion: p,
                clientReferenceMarkup: Decimal.min(
                  ...clients.map((u) =>
                    (u.markupOverride ?? clientRole.markup).toString(),
                  ),
                ).toString(),
              },
            ];
          }
        }
        return [];
      },
    );
    const eligible = candidates.map((c) => c.promotion);
    const [brands, products, systems] = await Promise.all([
      tx.brand.findMany({
        where: {
          id: { in: eligible.flatMap((p) => (p.brandId ? [p.brandId] : [])) },
        },
        select: { id: true, name: true },
      }),
      tx.product.findMany({
        where: {
          id: {
            in: eligible.flatMap((p) => [
              ...(p.productId ? [p.productId] : []),
              ...ids(p.excludedProductIds),
            ]),
          },
        },
        select: { id: true, name: true },
      }),
      tx.system.findMany({
        where: {
          id: {
            in: eligible.flatMap((p) => [
              ...(p.systemId ? [p.systemId] : []),
              ...ids(p.excludedSystemIds),
            ]),
          },
        },
        select: { id: true, name: true },
      }),
    ]);
    return candidates.map(({ promotion: p, clientReferenceMarkup }) => ({
      id: p.id,
      version: p.version,
      name: p.name,
      percent: p.percent.toString(),
      startsAt: p.startsAt.toISOString(),
      endsAt: p.endsAt.toISOString(),
      brandId: p.brandId,
      productId: p.productId,
      systemId: p.systemId,
      brandName: brands.find((b) => b.id === p.brandId)?.name ?? null,
      productName: products.find((b) => b.id === p.productId)?.name ?? null,
      systemName: systems.find((b) => b.id === p.systemId)?.name ?? null,
      excludedProductIds: ids(p.excludedProductIds),
      excludedSystemIds: ids(p.excludedSystemIds),
      excludedProductNames: ids(p.excludedProductIds).map(
        (id) => products.find((v) => v.id === id)?.name ?? `Product #${id}`,
      ),
      excludedSystemNames: ids(p.excludedSystemIds).map(
        (id) => systems.find((v) => v.id === id)?.name ?? `System #${id}`,
      ),
      ...(clientReferenceMarkup !== undefined
        ? { automaticDealerAdjustment: true, clientReferenceMarkup }
        : {}),
    }));
  }
  async available(
    actor: { id: number; role: { name: string } },
    estimateId?: number,
  ) {
    let owner = actor.id;
    let ownerMarkup: string | undefined;
    let applied: PromotionTerms[] = [];
    if (estimateId) {
      const estimate = await this.prisma.estimate.findUnique({
        where: { id: estimateId },
        select: {
          idUser: true,
          ownerMarkupSnapshot: true,
          pieces: {
            select: {
              regularPrice: true,
              price: true,
              promotionSnapshot: true,
            },
          },
        },
      });
      if (
        !estimate ||
        (estimate.idUser !== actor.id &&
          !['admin', 'operator'].includes(actor.role.name))
      )
        throw new NotFoundException('Estimate not found.');
      owner = estimate.idUser;
      ownerMarkup = estimate.ownerMarkupSnapshot.toString();
      applied = estimate.pieces.flatMap((piece) =>
        piece.regularPrice && piece.regularPrice.gt(piece.price)
          ? promotionTerms([piece.promotionSnapshot])
          : [],
      );
    }
    const eligible = await this.eligible(owner);
    if (
      ownerMarkup === undefined &&
      eligible.some((p) => p.automaticDealerAdjustment)
    ) {
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: owner },
        select: {
          markupOverride: true,
          role: { select: { markup: true } },
        },
      });
      ownerMarkup = (user.markupOverride ?? user.role.markup).toString();
    }
    const visible = eligible.filter((p) => {
      if (!p.automaticDealerAdjustment) return true;
      // Conserva el aviso de una pieza con ahorro real ya aplicado.
      if (
        applied.some(
          (saved) => saved.id === p.id && saved.version === p.version,
        )
      )
        return true;
      const dealerFactor = new Decimal(1).add(ownerMarkup!);
      const clientPromotionFactor = new Decimal(1)
        .add(p.clientReferenceMarkup!)
        .mul(new Decimal(1).sub(new Decimal(p.percent).div(100)));
      // Ya no se exige un descuento entero: también puede haber ahorro < 1%.
      // El importe definitivo se compara en centavos al cotizar la pieza.
      return dealerFactor.gt(0) && dealerFactor.gt(clientPromotionFactor);
    });
    return {
      serverNow: new Date().toISOString(),
      promotions: visible.map(
        ({ clientReferenceMarkup: _reference, ...p }) => ({
          ...p,
          // El porcentaje del client no es el descuento que recibirá el dealer.
          percent: p.automaticDealerAdjustment ? null : p.percent,
        }),
      ),
    };
  }
  list() {
    return this.prisma.promotion.findMany({ orderBy: { id: 'desc' } });
  }
  async remove(id: number): Promise<void> {
    // Los descuentos historicos viven en los snapshots del estimado y las piezas.
    // Solo elimina la oferta del catalogo, sin recalcular operaciones existentes.
    const { count } = await this.prisma.promotion.deleteMany({ where: { id } });
    if (!count) throw new NotFoundException('Promotion not found.');
  }
  async options() {
    const [roles, users, brands, products, systems] = await Promise.all([
      this.prisma.role.findMany({ select: { id: true, name: true } }),
      this.prisma.user.findMany({
        where: { deletedAt: null },
        select: { id: true, username: true, idRole: true },
      }),
      this.prisma.brand.findMany({ select: { id: true, name: true } }),
      this.prisma.product.findMany({ select: { id: true, name: true } }),
      this.prisma.system.findMany({
        select: { id: true, name: true, idBrand: true, idProduct: true },
      }),
    ]);
    return { roles, users, brands, products, systems };
  }
  async save(dto: PromotionDto, id?: number) {
    if (!dto.name.trim() || +new Date(dto.endsAt) <= +new Date(dto.startsAt))
      throw new BadRequestException('Check the name and promotion dates.');
    return this.prisma.$transaction(async (tx) => {
      if (id && !(await tx.promotion.findUnique({ where: { id } })))
        throw new NotFoundException('Promotion not found.');
      if (
        dto.audience === 'ROLE' &&
        (!dto.roleIds?.length ||
          (await tx.role.count({ where: { id: { in: dto.roleIds } } })) !==
            dto.roleIds.length)
      )
        throw new BadRequestException('Select at least one valid role.');
      if (
        dto.audience === 'USERS' &&
        (!dto.userIds?.length ||
          (await tx.user.count({
            where: { id: { in: dto.userIds }, deletedAt: null },
          })) !== dto.userIds.length)
      )
        throw new BadRequestException('Select valid users.');
      if (
        dto.brandId &&
        !(await tx.brand.findUnique({ where: { id: dto.brandId } }))
      )
        throw new BadRequestException('Invalid brand.');
      if (
        dto.productId &&
        !(await tx.product.findUnique({ where: { id: dto.productId } }))
      )
        throw new BadRequestException('Invalid product.');
      if (
        dto.brandId &&
        dto.productId &&
        !(await tx.brandProduct.findFirst({
          where: { idBrand: dto.brandId, idProduct: dto.productId },
        }))
      )
        throw new BadRequestException(
          'Product does not belong to the selected brand.',
        );
      if (dto.systemId) {
        const system = await tx.system.findUnique({
          where: { id: dto.systemId },
        });
        if (
          !system ||
          (dto.brandId && system.idBrand !== dto.brandId) ||
          (dto.productId && system.idProduct !== dto.productId)
        )
          throw new BadRequestException(
            'System does not match the selected filters.',
          );
      }
      const excludedProductIds = dto.excludedProductIds ?? [];
      const excludedSystemIds = dto.excludedSystemIds ?? [];
      if (
        excludedProductIds.length &&
        (await tx.product.count({
          where: { id: { in: excludedProductIds } },
        })) !== excludedProductIds.length
      )
        throw new BadRequestException('Select valid excluded products.');
      if (
        excludedSystemIds.length &&
        (await tx.system.count({
          where: { id: { in: excludedSystemIds } },
        })) !== excludedSystemIds.length
      )
        throw new BadRequestException('Select valid excluded systems.');
      const data = {
        name: dto.name.trim(),
        percent: new Prisma.Decimal(dto.percent),
        audience: dto.audience,
        roleIds: dto.audience === 'ROLE' ? dto.roleIds! : [],
        userIds: dto.audience === 'USERS' ? dto.userIds : [],
        excludedProductIds,
        excludedSystemIds,
        brandId: dto.brandId ?? null,
        productId: dto.productId ?? null,
        systemId: dto.systemId ?? null,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        enabled: dto.enabled,
      };
      return id
        ? tx.promotion.update({
            where: { id },
            data: { ...data, version: { increment: 1 } },
          })
        : tx.promotion.create({ data });
    });
  }
}
