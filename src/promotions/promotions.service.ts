import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { PromotionTerms } from './promotion-pricing';
import { PromotionDto } from './promotions.dto';
@Injectable()
export class PromotionsService {
  constructor(private prisma: PrismaService) {}
  async eligible(
    userId: number,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<PromotionTerms[]> {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { idRole: true },
    });
    const now = new Date();
    const rows = await tx.promotion.findMany({
      where: { enabled: true, startsAt: { lte: now }, endsAt: { gt: now } },
    });
    const eligible = rows.filter(
      (p) =>
        p.audience === 'ALL' ||
        (p.audience === 'ROLE' &&
          Array.isArray(p.roleIds) &&
          p.roleIds.includes(user.idRole)) ||
        (p.audience === 'USERS' &&
          Array.isArray(p.userIds) &&
          p.userIds.includes(userId)),
    );
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
            in: eligible.flatMap((p) => (p.productId ? [p.productId] : [])),
          },
        },
        select: { id: true, name: true },
      }),
      tx.system.findMany({
        where: {
          id: { in: eligible.flatMap((p) => (p.systemId ? [p.systemId] : [])) },
        },
        select: { id: true, name: true },
      }),
    ]);
    return eligible.map((p) => ({
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
    }));
  }
  async available(
    actor: { id: number; role: { name: string } },
    estimateId?: number,
  ) {
    let owner = actor.id;
    if (estimateId) {
      const estimate = await this.prisma.estimate.findUnique({
        where: { id: estimateId },
      });
      if (
        !estimate ||
        (estimate.idUser !== actor.id &&
          !['admin', 'operator'].includes(actor.role.name))
      )
        throw new NotFoundException('Estimate not found.');
      owner = estimate.idUser;
    }
    return {
      serverNow: new Date().toISOString(),
      promotions: await this.eligible(owner),
    };
  }
  list() {
    return this.prisma.promotion.findMany({ orderBy: { id: 'desc' } });
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
      const data = {
        name: dto.name.trim(),
        percent: new Prisma.Decimal(dto.percent),
        audience: dto.audience,
        roleIds: dto.audience === 'ROLE' ? dto.roleIds! : [],
        userIds: dto.audience === 'USERS' ? dto.userIds : [],
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
