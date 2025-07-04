import { Controller, Get, Post, Body, Patch, Param, Delete, Query, ParseIntPipe } from '@nestjs/common';
import { SystemsService } from './systems.service';
import { CreateSystemDto } from './dto/create-system.dto';
import { UpdateSystemDto } from './dto/update-system.dto';
import { System as SystemModel } from '@prisma/client';

@Controller('systems')
export class SystemsController {
  constructor(private readonly systemsService: SystemsService) {}

  @Post()
  async createSystem(
    @Body() systemData: CreateSystemDto,
  ): Promise<SystemModel> {
    return this.systemsService.createSystem(systemData);
  }

  @Post(':id/configs/:configId')
  async addConfigToSystem(
    @Param('id', ParseIntPipe) id: number,
    @Param('configId', ParseIntPipe) configId: number,
  ) {
    return this.systemsService.addConfigToSystem(id, configId);
  }

  @Get()
  async getSystems(@Query('product') idP?: string, @Query('brand') idB?: string): Promise<SystemModel[]> {
    const where: any = {};
    if (idB) where.idBrand = Number(idB);
    if (idP) where.idProduct = Number(idP);
    
    return this.systemsService.systems({ where });
  }

  @Get(':id')
  async getSystem(@Param('id', ParseIntPipe) id: number): Promise<SystemModel> {
    return this.systemsService.system({ id });
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
    @Param('id', ParseIntPipe) id: number,
    @Body() systemData: UpdateSystemDto,
  ): Promise<SystemModel> {
    return this.systemsService.updateSystem({
      where: { id },
      data: systemData,
    });
  }

  @Delete(':id')
  async deleteSystem(@Param('id', ParseIntPipe) id: number): Promise<SystemModel> {
    return this.systemsService.deleteSystem({ id });
  }

  @Delete(':id/configs/:configId')
  async removeConfigFromSystem(
    @Param('id', ParseIntPipe) id: number,
    @Param('configId', ParseIntPipe) configId: number,
  ) {
    return this.systemsService.removeConfigFromSystem(id, configId);
  }
}