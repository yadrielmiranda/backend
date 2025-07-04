import { Injectable, NotFoundException } from '@nestjs/common';
import { Config, Prisma, System } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateSystemDto } from './dto/create-system.dto';
import { UpdateSystemDto } from './dto/update-system.dto';


@Injectable()
export class SystemsService {

  constructor(private prisma: PrismaService) { }

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

  async createSystem(systemData: CreateSystemDto): Promise<System> {
    const { name, idBrand, idProduct } = systemData;

   
    const brandProductExists = await this.prisma.brandProduct.findUnique({
      where: {
        idBrand_idProduct: {
          idBrand: idBrand,
          idProduct: idProduct,
        }
      }
    });

    if (!brandProductExists) {
      throw new NotFoundException(`La combinación de la marca con ID ${idBrand} y el producto con ID ${idProduct} no existe.`);
    }


    //Creamos el sistema pasando los IDs directamente.

    return this.prisma.system.create({
      data: {
        name,
        idBrand,   // Pasamos el ID de la marca directamente
        idProduct, // Pasamos el ID del producto directamente
      }
    });
  }

  async updateSystem(params: {
    where: Prisma.SystemWhereUniqueInput;
    data: UpdateSystemDto;
  }): Promise<System> {
    const { where, data } = params;
    return this.prisma.system.update({
      data,
      where
    });
  }

  async deleteSystem(where: Prisma.SystemWhereUniqueInput): Promise<System> {
    return this.prisma.system.delete({
      where
    });
  }

  async getSystemWithConfigs(systemId: number): Promise<System | null> {
    return this.prisma.system.findUnique({
      where: { id: systemId },
      include: {
        sysconfs: { // Incluye las entradas de la tabla de unión
          include: {
            config: true, // Y dentro, los datos de la configuración
          },
        },
        brandProduct: { // También incluimos esto para saber a qué producto pertenece
          include: {
            product: true,
          }
        }
      },
    });
  }

  async getAvailableConfigsForSystem(systemId: number): Promise<Config[]> {
    // Primero, encontramos el producto al que pertenece el sistema
    const system = await this.prisma.system.findUnique({
      where: { id: systemId },
      select: { idProduct: true } // Solo necesitamos el id del producto
    });

    if (!system) {
      throw new NotFoundException(`Sistema con ID ${systemId} no encontrado.`);
    }

    // Luego, encontramos los IDs de las configuraciones ya asociadas
    const associatedConfigs = await this.prisma.sysConf.findMany({
      where: { idSystem: systemId },
      select: { idConfig: true }
    });
    const associatedConfigIds = associatedConfigs.map(c => c.idConfig);

    
    return this.prisma.config.findMany({
      where: {
        idProduct: system.idProduct, // Deben ser del mismo producto
        id: {
          notIn: associatedConfigIds // Y no deben estar ya asociadas
        }
      }
    });
  }

  async addConfigToSystem(systemId: number, configId: number): Promise<System> {
    // Prisma se encarga de verificar que ambos IDs existan antes de crear la relación
    await this.prisma.sysConf.create({
      data: {
        idSystem: systemId,
        idConfig: configId,
      }
    });
    return this.getSystemWithConfigs(systemId); // Devuelve el sistema actualizado
  }

  async removeConfigFromSystem(systemId: number, configId: number): Promise<System> {
    await this.prisma.sysConf.delete({
      where: {
        idSystem_idConfig: { // Usamos la clave compuesta para encontrar el registro a borrar
          idSystem: systemId,
          idConfig: configId,
        }
      }
    });
    return this.getSystemWithConfigs(systemId); // Devuelve el sistema actualizado
  }
}
