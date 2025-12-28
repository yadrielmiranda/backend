// systems.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, System } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateSystemDto } from './dto/create-system.dto';
import { UpdateSystemDto } from './dto/update-system.dto';

@Injectable()
export class SystemsService {
  constructor(private prisma: PrismaService) {}

  async system(where: Prisma.SystemWhereUniqueInput): Promise<System> {
    const system = await this.prisma.system.findUnique({
      where,
      include: {
        brandProduct: {
          include: {
            brand: true,
            product: true,
          },
        },
      },
    });

    if (!system) {
      throw new NotFoundException(`System with ID #${where.id} not found.`);
    }
    return system;
  }

  async systems(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.SystemWhereUniqueInput;
    where?: Prisma.SystemWhereInput;
    orderBy?: Prisma.SystemOrderByWithRelationInput;
  }): Promise<System[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.system.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
      include: {
        brandProduct: {
          include: { brand: true, product: true },
        },
      },
    });
  }

  /** Devuelve todos los sistemas con sus configuraciones asociadas */
  async findAllWithConfigs(): Promise<System[]> {
    return this.prisma.system.findMany({
      include: {
        sysconfs: { include: { config: true } },
      },
      orderBy: { id: 'asc' },
    });
  }

  async createSystem(systemData: CreateSystemDto): Promise<System> {
    const { name, idBrand, idProduct } = systemData;

    // Verifica que exista la pareja (brand, product) en la tabla pivote
    const brandProductExists = await this.prisma.brandProduct.findUnique({
      where: {
        idBrand_idProduct: { idBrand, idProduct },
      },
      select: { idBrand: true, idProduct: true },
    });

    if (!brandProductExists) {
      throw new NotFoundException(
        `Brand/Product pair not found (brandId=${idBrand}, productId=${idProduct}).`,
      );
    }

    return this.prisma.system.create({
      data: { name, idBrand, idProduct },
    });
  }

  async updateSystem(params: {
    where: Prisma.SystemWhereUniqueInput;
    data: UpdateSystemDto;
  }): Promise<System> {
    const { where, data } = params;

    try {
      return await this.prisma.system.update({ data, where });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`System with ID #${where.id} not found.`);
      }
      throw e;
    }
  }

  async deleteSystem(where: Prisma.SystemWhereUniqueInput): Promise<System> {
    try {
      return await this.prisma.system.delete({ where });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`System with ID #${where.id} not found.`);
      }
      throw e;
    }
  }

  async getSystemWithConfigs(systemId: number): Promise<System> {
    const system = await this.prisma.system.findUnique({
      where: { id: systemId },
      include: {
        sysconfs: { include: { config: true } },
        brandProduct: { include: { product: true, brand: true } },
      },
    });

    if (!system) {
      throw new NotFoundException(`System with ID #${systemId} not found.`);
    }

    return system;
  }

  /**
   * Configs disponibles para un System:
   * - Mismo product que el System
   * - Excluye ya asociadas
   */
  async getAvailableConfigsForSystem(systemId: number) {
    const system = await this.prisma.system.findUnique({
      where: { id: systemId },
      select: { idProduct: true },
    });

    if (!system) {
      throw new NotFoundException(`System with ID #${systemId} not found.`);
    }

    const associatedConfigs = await this.prisma.sysConf.findMany({
      where: { idSystem: systemId },
      select: { idConfig: true },
    });

    const associatedConfigIds = associatedConfigs.map((c) => c.idConfig);

    return this.prisma.config.findMany({
      where: {
        idProduct: system.idProduct,
        id: associatedConfigIds.length
          ? { notIn: associatedConfigIds }
          : undefined,
      },
      orderBy: { conf: 'asc' },
    });
  }

  /**
   * Asocia una Config a un System con defensa en profundidad:
   * - Verifica existencia
   * - Valida que pertenecen al mismo Product
   * - Upsert idempotente
   */
  async addConfigToSystem(systemId: number, configId: number) {
    const [system, config] = await Promise.all([
      this.prisma.system.findUnique({
        where: { id: systemId },
        select: { id: true, idProduct: true },
      }),
      this.prisma.config.findUnique({
        where: { id: configId },
        select: { id: true, idProduct: true },
      }),
    ]);

    if (!system) throw new NotFoundException(`System #${systemId} not found.`);
    if (!config) throw new NotFoundException(`Config #${configId} not found.`);

    if (system.idProduct !== config.idProduct) {
      throw new BadRequestException(
        `Config #${configId} belongs to a different product and cannot be linked to this system.`,
      );
    }

    await this.prisma.sysConf.upsert({
      where: { idSystem_idConfig: { idSystem: systemId, idConfig: configId } },
      update: {},
      create: { idSystem: systemId, idConfig: configId },
    });

    return this.getSystemWithConfigs(systemId);
  }

  /** Elimina la asociación System ⇄ Config (404 si no existe) */
  async removeConfigFromSystem(systemId: number, configId: number): Promise<System> {
    try {
      await this.prisma.sysConf.delete({
        where: { idSystem_idConfig: { idSystem: systemId, idConfig: configId } },
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(
          `System/Config link not found (systemId=${systemId}, configId=${configId}).`,
        );
      }
      throw e;
    }

    return this.getSystemWithConfigs(systemId);
  }
}
