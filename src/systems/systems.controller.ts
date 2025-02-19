import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
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
    const { name, idProduct } = systemData;
    return this.systemsService.createSystem({  //Aqui es donde se verifica que exista ese id en la tabla product
      name,
      prod: {
        connect: { id: idProduct },
      },
    });
  }

  @Get()
  async getAllUsers(): Promise<SystemModel[]> {
    return this.systemsService.systems({});
  }

  @Get(':id')
  async getUser(@Param('id') id: string): Promise<SystemModel> {
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
