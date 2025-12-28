// systems.controller.ts
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
import { Roles } from 'src/auth/roles.decorator';

@Controller('systems')
export class SystemsController {
  constructor(private readonly systemsService: SystemsService) {}

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

  // ✅ READ: todos los usuarios autenticados
  @Get('with-configs')
  findAllWithConfigs() {
    return this.systemsService.findAllWithConfigs();
  }

  // ✅ READ: todos los usuarios autenticados  
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

  // ✅ READ: todos los usuarios autenticados
  @Get(':id')
  async getSystem(@Param('id', ParseIntPipe) id: number) {
    return this.systemsService.system({ id });
  }

  // ✅ READ: todos los usuarios autenticados
  @Get(':id/configs')
  async getSystemConfigs(@Param('id', ParseIntPipe) id: number) {
    return this.systemsService.getSystemWithConfigs(id);
  }

  // ✅ READ: todos los usuarios autenticados  
  @Get(':id/available-configs')
  async getAvailableConfigs(@Param('id', ParseIntPipe) id: number) {
    return this.systemsService.getAvailableConfigsForSystem(id);
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
