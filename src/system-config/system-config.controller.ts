import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { SystemConfigService } from './system-config.service';
import { CreateSystemConfigDto } from './dto/create-system-config.dto';
import { SysConf as SysConfModel } from '@prisma/client';
import { UpdateSystemConfigDto } from './dto/update-system-config.dto';

@Controller('systemconfigs')
export class SystemConfigController {
  constructor(private readonly systemConfigService: SystemConfigService) { }

  @Post()
  async createSysConf(
    @Body() sysConfData: CreateSystemConfigDto,
  ): Promise<SysConfModel> {
    const { idSys, idConf } = sysConfData;
    return this.systemConfigService.createSysConf({
      syst: {
        connect: { id: idSys },  //Aqui es donde se verifica que exista ese idSys en la tabla System
      },
      config: {
        connect: { id: idConf },    //Aqui es donde se verifica que exista ese id en la tabla SysConf
      },
    });
  }

  @Get()
  async getAllSysConf(): Promise<SysConfModel[]> {
    return this.systemConfigService.sysConfs({});
  }

  @Get(':id')
  async getSysConf(@Param('id') id: string): Promise<SysConfModel> {
    return this.systemConfigService.sysConf({ id: Number(id) });
  }

    @Patch(':id')
    async updateSystem(
      @Param('id') id: string,
      @Body() sysConfData: UpdateSystemConfigDto,
    ): Promise<SysConfModel> {
      
      return this.systemConfigService.updateSysConf({
        where: { id: Number(id) },
        data: sysConfData});
    }

  @Delete(':id')
  async deleteSysConf(@Param('id') id: string): Promise<SysConfModel> {
    return this.systemConfigService.deleteSysConf({ id: Number(id) });
  }
}
