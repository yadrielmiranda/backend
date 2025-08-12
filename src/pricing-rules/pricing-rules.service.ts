// src/pricing-rules/pricing-rules.service.ts
import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreatePricingRuleDto } from './dto/create-pricing-rule.dto';
import { UpdatePricingRuleDto } from './dto/update-pricing-rule.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class PricingRulesService {
  constructor(private prisma: PrismaService) { }

  async create(dto: CreatePricingRuleDto) {
    // Verificar si ya existe una regla para esta combinación exacta
    const existingRule = await this.prisma.pricingRule.findUnique({
      where: {
        idBrand_idProduct_idSystem_idConfig_idCrystal: {
          idBrand: dto.idBrand,
          idProduct: dto.idProduct,
          idSystem: dto.idSystem,
          idConfig: dto.idConfig,
          idCrystal: dto.idCrystal,
        },
      },
    });

    if (existingRule) {
      throw new ConflictException(
        'A pricing rule for this exact combination already exists.',
      );
    }

    return this.prisma.pricingRule.create({
      data: dto,
    });
  }

  findAll() {
    // Incluimos los nombres para que sea más fácil de ver en un panel de administración
    return this.prisma.pricingRule.findMany({
      include: {
        brand: { select: { name: true } },
        product: { select: { name: true } },
        system: { select: { name: true } },
        config: { select: { conf: true } },
        crystal: { select: { glass: true } },
      },
      orderBy: {
        id: 'asc'
      }
    });
  }

  async findOne(id: number) {
    const rule = await this.prisma.pricingRule.findUnique({ where: { id } });
    if (!rule) {
      throw new NotFoundException(`Pricing Rule with ID #${id} not found.`);
    }
    return rule;
  }

  async update(id: number, dto: UpdatePricingRuleDto) {
    await this.findOne(id); // Asegurarse de que existe antes de intentar actualizar
    try {
      return await this.prisma.pricingRule.update({
        where: { id },
        data: dto,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('This update would create a duplicate pricing rule.');
      }
      throw error;
    }
  }

  async remove(id: number) {
    await this.findOne(id); // Asegurarse de que existe
    return this.prisma.pricingRule.delete({ where: { id } });
  }
}