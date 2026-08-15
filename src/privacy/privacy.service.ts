import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, Privacy } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { CreatePrivacyDto } from "./dto/create-privacy.dto";

@Injectable()
export class PrivacyService {
  constructor(private prisma: PrismaService) {}

  async privacy(where: Prisma.PrivacyWhereUniqueInput): Promise<Privacy> {
    const privacy = await this.prisma.privacy.findUnique({ where });

    if (!privacy) {
      throw new NotFoundException(
        `Privacy option with ID #${where.id} not found.`,
      );
    }

    return privacy;
  }

  async privacies(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.PrivacyWhereUniqueInput;
    where?: Prisma.PrivacyWhereInput;
    orderBy?: Prisma.PrivacyOrderByWithRelationInput;
  }): Promise<Privacy[]> {
    const { skip, take, cursor, where, orderBy } = params;

    return this.prisma.privacy.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy: orderBy ?? [{ name: "asc" }, { id: "asc" }],
      include: {
        brandPrivacies: {
          select: {
            idBrand: true,
            sortOrder: true,
            surchargeEnabled: true,
            isDefault: true,
          },
        },
      },
    });
  }

  async createPrivacy(data: CreatePrivacyDto): Promise<Privacy> {
    return this.prisma.privacy.create({
      data: {
        name: data.name.trim(),
      },
    });
  }

  async updatePrivacy(params: {
    where: Prisma.PrivacyWhereUniqueInput;
    data: Prisma.PrivacyUpdateInput;
  }): Promise<Privacy> {
    const { where, data } = params;

    try {
      if (data.isActive === false) {
        const defaultAssociation = await this.prisma.brandPrivacy.findFirst({
          where: {
            idPrivacy: where.id,
            isDefault: true,
          },
          select: { idBrand: true },
        });

        if (defaultAssociation) {
          throw new ConflictException(
            "This Privacy option is a Brand default. Select another default before deactivating it.",
          );
        }
      }

      return await this.prisma.privacy.update({
        where,
        data: {
          ...data,
          ...(typeof data.name === "string" ? { name: data.name.trim() } : {}),
        },
      });
    } catch (error: any) {
      if (error?.code === "P2025") {
        throw new NotFoundException(
          `Privacy option with ID #${where.id} not found.`,
        );
      }

      throw error;
    }
  }

  async deletePrivacy(where: Prisma.PrivacyWhereUniqueInput): Promise<Privacy> {
    try {
      return await this.prisma.privacy.delete({ where });
    } catch (error: any) {
      if (error?.code === "P2025") {
        throw new NotFoundException(
          `Privacy option with ID #${where.id} not found.`,
        );
      }

      if (error?.code === "P2003") {
        throw new ConflictException(
          "This Privacy option is being used and cannot be deleted. Deactivate it instead.",
        );
      }

      throw error;
    }
  }
}
