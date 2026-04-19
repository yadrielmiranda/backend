import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  ParseIntPipe,
} from '@nestjs/common';
import { SystemsService } from './systems.service';
import { CreateSystemDto } from './dto/create-system.dto';
import { UpdateSystemDto } from './dto/update-system.dto';
import { UpdateSystemConfigDto } from './dto/update-system-config.dto';
import { Roles } from 'src/auth/roles.decorator';

@Controller('systems')
export class SystemsController {
  constructor(private readonly systemsService: SystemsService) { }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Post()
  async createSystem(@Body() systemData: CreateSystemDto) {
    return this.systemsService.createSystem(systemData);
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Post(':id/configs/:configId')
  async addConfigToSystem(
    @Param('id', ParseIntPipe) id: number,
    @Param('configId', ParseIntPipe) configId: number,
  ) {
    return this.systemsService.addConfigToSystem(id, configId);
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Patch(':id/configs/:configId')
  async updateSystemConfig(
    @Param('id', ParseIntPipe) id: number,
    @Param('configId', ParseIntPipe) configId: number,
    @Body() body: UpdateSystemConfigDto,
  ) {
    return this.systemsService.updateSystemConfig(id, configId, body);
  }

  // ✅ READ: todos los usuarios autenticados
  @Get('with-configs')
  findAllWithConfigs() {
    return this.systemsService.findAllWithConfigs();
  }

  @Get()
  async getSystems(
    @Query('product') idP?: string,
    @Query('brand') idB?: string,
  ) {
    const where: any = {};
    if (idB) where.idBrand = Number(idB);
    if (idP) where.idProduct = Number(idP);

    return this.systemsService.systems({ where });
  }

  @Get(':id/configs/:configId/options')
  async getSystemConfigOptions(
    @Param('id', ParseIntPipe) id: number,
    @Param('configId', ParseIntPipe) configId: number,
  ) {
    return this.systemsService.getSystemConfigOptions(id, configId);
  }

  @Get(':id/configs')
  async getSystemConfigs(@Param('id', ParseIntPipe) id: number) {
    return this.systemsService.getSystemWithConfigs(id);
  }

  @Get(':id/available-configs')
  async getAvailableConfigs(@Param('id', ParseIntPipe) id: number) {
    return this.systemsService.getAvailableConfigsForSystem(id);
  }

  @Get(':id')
  async getSystem(@Param('id', ParseIntPipe) id: number) {
    return this.systemsService.system({ id });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Patch(':id')
  async updateSystem(
    @Param('id', ParseIntPipe) id: number,
    @Body() systemData: UpdateSystemDto,
  ) {
    return this.systemsService.updateSystem({
      where: { id },
      data: systemData,
    });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Delete(':id')
  async deleteSystem(@Param('id', ParseIntPipe) id: number) {
    return this.systemsService.deleteSystem({ id });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Delete(':id/configs/:configId')
  async removeConfigFromSystem(
    @Param('id', ParseIntPipe) id: number,
    @Param('configId', ParseIntPipe) configId: number,
  ) {
    return this.systemsService.removeConfigFromSystem(id, configId);
  }
}