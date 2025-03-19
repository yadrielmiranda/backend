import { Controller, Get, Post, Body, Patch, Param, Delete, Query } from '@nestjs/common';
import { SystemsService } from './systems.service';
import { CreateSystemDto } from './dto/create-system.dto';
import { UpdateSystemDto } from './dto/update-system.dto';
import { System as SystemModel } from '@prisma/client';

@Controller('systems')
export class SystemsController {
  constructor(private readonly systemsService: SystemsService) { }

  @Post()
  async createSystem(
    @Body() systemData: CreateSystemDto,
  ): Promise<SystemModel> {
    const { name, idProduct, idBrand } = systemData;
    return this.systemsService.createSystem({  //Aqui es donde se verifica que exista ese id en la tabla product
      name,
      prod: {
        connect: { id: idProduct },
      },
      bran: {
        connect: { id: idBrand },    //Aqui es donde se verifica que exista ese id en la tabla SysConf
      },
    });
  }
  /*
    @Get()
    async getAllSystems(): Promise<SystemModel[]> {
      return this.systemsService.systems({});
    }
  
    @Get('product') //en esta ruta busco los sistemas que tienen el id de producto que les paso en la query ejem: ?product=1
    async getSystemsByProd(@Query('product') idP?: any): Promise<SystemModel[]> {
      return this.systemsService.systems({ where: { idProduct: Number(idP) } });
    }
  */
  @Get() //en esta ruta busco todos los systems o los systems que tienen el id de producto que les paso en la query ejem: ?product=1
  async getSystems(@Query('product') idP?: string, @Query('brand') idB?: string): Promise<SystemModel[]> {
    if (idP) { // si hay query  
      return this.systemsService.systems({ where: { idProduct: Number(idP), idBrand: Number(idB) } });  //devuelvo los systems que tienen esos id 
    } else { // si no hay query
      return this.systemsService.systems({}); // devuelvo todos los systems
    }

  }

  @Get(':id')
  async getSystem(@Param('id') id: string): Promise<SystemModel> {
    return this.systemsService.system({ id: Number(id) });
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

}
