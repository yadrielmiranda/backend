import { Controller, Get, Post, Body, Patch, Param, Delete, Query, ParseIntPipe } from '@nestjs/common';
import { SystemsService } from './systems.service';
import { CreateSystemDto } from './dto/create-system.dto';
import { UpdateSystemDto } from './dto/update-system.dto';
import { System as SystemModel } from '@prisma/client';


@Controller('systems')
export class SystemsController {
  constructor(private readonly systemsService: SystemsService) { }

  @Post()
    async createSystem(
        @Body() systemData: CreateSystemDto, // Recibimos el DTO completo
    ): Promise<SystemModel> {
        // Simplemente pasamos todos los datos al servicio.
        // El servicio se encarga de la validación y la lógica de conexión.
        return this.systemsService.createSystem(systemData);
    }

       @Post(':id/configs/:configId')
    async addConfigToSystem(
        @Param('id', ParseIntPipe) id: number,
        @Param('configId', ParseIntPipe) configId: number
    ) {
        return this.systemsService.addConfigToSystem(id, configId);
    }

  @Get() //en esta ruta busco todos los systems o los systems que tienen el id de producto que les paso en la query ejem: ?product=1
  async getSystems(@Query('product') idP?: string, @Query('brand') idB?: string): Promise<SystemModel[]> {
    if (idP) {
      if (idB) { // si hay query  
        return this.systemsService.systems({ where: { idProduct: Number(idP), idBrand: Number(idB) } });  //devuelvo los systems que tienen esos id 
      } else {
        return this.systemsService.systems({ where: { idProduct: Number(idP) } });
      }
    } if (idB) { // si hay query  
      return this.systemsService.systems({ where: { idBrand: Number(idB) } });  //devuelvo los systems que tienen esos id 
    } else { // si no hay query
      return this.systemsService.systems({}); // devuelvo todos los systems
    }

  }

  @Get(':id')
  async getSystem(@Param('id') id: string): Promise<SystemModel> {
    return this.systemsService.system({ id: Number(id) });
  }

    @Get(':id/configs')
    async getSystemConfigs(@Param('id', ParseIntPipe) id: number) {
        return this.systemsService.getSystemWithConfigs(id);
    }

@Get(':id/available-configs')
    async getAvailableConfigs(@Param('id', ParseIntPipe) id: number) {
        return this.systemsService.getAvailableConfigsForSystem(id);
    }

  @Patch(':id')
  async updateSystem(
    @Param('id') id: string,
    @Body() systemData: UpdateSystemDto,
  ): Promise<SystemModel> {
    return this.systemsService.updateSystem({
      where: { id: Number(id) },
      data: systemData,
    });
  }

  @Delete(':id')
  async deleteSystem(@Param('id') id: string): Promise<SystemModel> {
    return this.systemsService.deleteSystem({ id: Number(id) });
  }

    @Delete(':id/configs/:configId')
    async removeConfigFromSystem(
        @Param('id', ParseIntPipe) id: number,
        @Param('configId', ParseIntPipe) configId: number
    ) {
        return this.systemsService.removeConfigFromSystem(id, configId);
    }

}
