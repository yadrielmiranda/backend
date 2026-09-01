import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "@/prisma/prisma.service";
import { BrandingType } from "@prisma/client";
import { CreateBrandingDto } from "./dto/create-branding.dto";
import { UpdateBrandingDto } from "./dto/update-branding.dto";

function stripQuery(url?: string | null) {
  // ✅ Guardamos limpio en DB: sin ?v=...
  if (!url) return url ?? null;
  return url.split("?")[0];
}

@Injectable()
export class BrandingsService {
  constructor(private readonly prisma: PrismaService) {}

  // =====================================================
  // COMPANY BRANDING (solo 1)
  // =====================================================

  async getCompanyBranding() {
    return this.prisma.branding.findFirst({
      where: { type: BrandingType.COMPANY },
    });
  }

  async createCompanyBranding(dto: CreateBrandingDto) {
    const existing = await this.prisma.branding.findFirst({
      where: { type: BrandingType.COMPANY },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException(
        "Company branding already exists. Use update instead.",
      );
    }

    return this.prisma.branding.create({
      data: {
        type: BrandingType.COMPANY,
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        website: dto.website,
        street: dto.street,
        city: dto.city,
        state: dto.state,
        postalCode: dto.postalCode,
        logoUrl: stripQuery(dto.logoUrl),
        brandingColor: dto.brandingColor,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async updateCompanyBranding(dto: UpdateBrandingDto) {
    const existing = await this.prisma.branding.findFirst({
      where: { type: BrandingType.COMPANY },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException(
        "Company branding does not exist. Create it first.",
      );
    }

    return this.prisma.branding.update({
      where: { id: existing.id },
      data: {
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        website: dto.website,
        street: dto.street,
        city: dto.city,
        state: dto.state,
        postalCode: dto.postalCode,
        logoUrl: stripQuery(dto.logoUrl),
        brandingColor: dto.brandingColor,
        isActive: dto.isActive,
      },
    });
  }

  // =====================================================
  // DEALER BRANDING (1 por dealer)
  // =====================================================

  async getDealerBranding(userId: number) {
    return this.prisma.branding.findFirst({
      where: { type: BrandingType.DEALER, userId },
    });
  }

  async createDealerBranding(userId: number, dto: CreateBrandingDto) {
    const existing = await this.prisma.branding.findFirst({
      where: { type: BrandingType.DEALER, userId },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException(
        "Dealer branding already exists. Use update instead.",
      );
    }

    return this.prisma.branding.create({
      data: {
        type: BrandingType.DEALER,
        userId,
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        website: dto.website,
        street: dto.street,
        city: dto.city,
        state: dto.state,
        postalCode: dto.postalCode,
        logoUrl: stripQuery(dto.logoUrl),
        brandingColor: dto.brandingColor,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async updateDealerBranding(userId: number, dto: UpdateBrandingDto) {
    const existing = await this.prisma.branding.findFirst({
      where: { type: BrandingType.DEALER, userId },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException(
        "Dealer branding does not exist. Create it first.",
      );
    }

    return this.prisma.branding.update({
      where: { id: existing.id },
      data: {
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        website: dto.website,
        street: dto.street,
        city: dto.city,
        state: dto.state,
        postalCode: dto.postalCode,
        logoUrl: stripQuery(dto.logoUrl),
        brandingColor: dto.brandingColor,
        isActive: dto.isActive,
      },
    });
  }
}
