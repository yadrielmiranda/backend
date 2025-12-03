// systems.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Config, Prisma, System } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateSystemDto } from './dto/create-system.dto';
import { UpdateSystemDto } from './dto/update-system.dto';

@Injectable()
export class SystemsService {
  constructor(private prisma: PrismaService) {}

  async system(
    systemWhereUniqueInput: Prisma.SystemWhereUniqueInput
  ): Promise<System | null> {
    return this.prisma.system.findUnique({
      where: systemWhereUniqueInput,
      include: {
        brandProduct: {
          include: {
            brand: true,
            product: true,
          },
        },
      },
    });
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
          include: {
            brand: true,
            product: true,
          },
        },
      },
    });
  }

  /** Devuelve todos los sistemas con sus configuraciones asociadas */
  async findAllWithConfigs(): Promise<System[]> {
    return this.prisma.system.findMany({
      include: {
        sysconfs: {
          include: { config: true },
        },
      },
    });
  }

  async createSystem(systemData: CreateSystemDto): Promise<System> {
    const { name, idBrand, idProduct } = systemData;

    // Verifica que exista la pareja (brand, product) en la tabla pivote
    const brandProductExists = await this.prisma.brandProduct.findUnique({
      where: {
        idBrand_idProduct: {
          idBrand: idBrand,
          idProduct: idProduct,
        },
      },
    });

    if (!brandProductExists) {
      throw new NotFoundException(
        `La combinación de la marca con ID ${idBrand} y el producto con ID ${idProduct} no existe.`,
      );
    }

    return this.prisma.system.create({
      data: {
        name,
        idBrand,
        idProduct,
      },
    });
  }

  async updateSystem(params: {
    where: Prisma.SystemWhereUniqueInput;
    data: UpdateSystemDto;
  }): Promise<System> {
    const { where, data } = params;
    return this.prisma.system.update({
      data,
      where,
    });
  }

  async deleteSystem(where: Prisma.SystemWhereUniqueInput): Promise<System> {
    return this.prisma.system.delete({ where });
  }

  async getSystemWithConfigs(systemId: number): Promise<System | null> {
    return this.prisma.system.findUnique({
      where: { id: systemId },
      include: {
        sysconfs: { include: { config: true } },
        brandProduct: { include: { product: true } },
      },
    });
  }

  /**
   * Configs disponibles para un System:
   * - Mismo product que el System
   * - Excluye ya asociadas
   * - Ordena por id (seguro en cualquier esquema)
   */
  async getAvailableConfigsForSystem(systemId: number) {
  const system = await this.prisma.system.findUnique({
    where: { id: systemId },
    select: { idProduct: true },
  });
  if (!system) {
    throw new NotFoundException(`Sistema con ID ${systemId} no encontrado.`);
  }

  const associatedConfigs = await this.prisma.sysConf.findMany({
    where: { idSystem: systemId },
    select: { idConfig: true },
  });
  const associatedConfigIds = associatedConfigs.map((c) => c.idConfig);

  return this.prisma.config.findMany({
    where: {
      idProduct: system.idProduct,
      id: associatedConfigIds.length ? { notIn: associatedConfigIds } : undefined,
    },
    orderBy: { conf: 'asc' }, 
  });
}

  /**
   * Asocia una Config a un System con defensa en profundidad:
   * - Verifica existencia
   * - Valida que pertenecen al mismo Product
   * - Upsert idempotente
   * - Devuelve el sistema con sus configs
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

  if (!system) throw new NotFoundException(`Sistema ${systemId} no encontrado`);
  if (!config) throw new NotFoundException(`Config ${configId} no encontrada`);
  if (system.idProduct !== config.idProduct) {
    throw new BadRequestException(
      `La configuración ${configId} pertenece a otro producto y no puede asociarse a este sistema.`,
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
          `La asociación Sistema(${systemId}) ⇄ Config(${configId}) no existe.`,
        );
      }
      throw e;
    }
    return this.getSystemWithConfigs(systemId) as Promise<System>;
  }
}
