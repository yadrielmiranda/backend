import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { InstallationCatalogService } from './installation-catalog.service';
import {
  AddBulkSysConfInstallationServiceDto,
  CreateInstallationServiceDto,
  SetSysConfInstallationServicesDto,
  UpdateInstallationServiceDto,
} from './dto/installation-catalog.dto';
import {
  CreateInstallationPriceProfileDto,
  UpdateInstallationPriceProfileDto,
} from './dto/installation-profile.dto';

@Controller()
export class InstallationCatalogController {
  constructor(private readonly catalog: InstallationCatalogService) {}

  @Get('installation-services')
  findServices(
    @Query('includeInactive', new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
  ) {
    return this.catalog.findServices(includeInactive ?? false);
  }

  @Get('installation-services/:id')
  findService(@Param('id', ParseIntPipe) id: number) {
    return this.catalog.findService(id);
  }

  @Roles('admin')
  @Post('installation-services')
  createService(
    @Body() dto: CreateInstallationServiceDto,
    @Req() req: Request,
  ) {
    return this.catalog.createService(dto, req.user as AuthUser);
  }

  @Roles('admin')
  @Patch('installation-services/:id')
  updateService(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInstallationServiceDto,
    @Req() req: Request,
  ) {
    return this.catalog.updateService(id, dto, req.user as AuthUser);
  }

  @Roles('admin')
  @Delete('installation-services/:id')
  removeService(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    return this.catalog.removeService(id, req.user as AuthUser);
  }

  @Roles('admin', 'operator')
  @Get('installation-service-mappings/direct')
  findDirectSysConfServiceMappings() {
    return this.catalog.findDirectSysConfServiceMappings();
  }

  @Roles('admin')
  @Post('installation-services/sysconf-mappings/bulk')
  addBulkSysConfServiceMappings(
    @Body() dto: AddBulkSysConfInstallationServiceDto,
    @Req() req: Request,
  ) {
    return this.catalog.addBulkSysConfServiceMappings(
      dto,
      req.user as AuthUser,
    );
  }

  @Roles('admin')
  @Delete('installation-services/sysconf-mappings/bulk')
  removeBulkSysConfServiceMappings(
    @Body() dto: AddBulkSysConfInstallationServiceDto,
    @Req() req: Request,
  ) {
    return this.catalog.removeBulkSysConfServiceMappings(
      dto,
      req.user as AuthUser,
    );
  }

  @Roles('admin', 'operator')
  @Get('systems/:idSystem/configs/:idConfig/installation-services')
  getSysConfServices(
    @Param('idSystem', ParseIntPipe) idSystem: number,
    @Param('idConfig', ParseIntPipe) idConfig: number,
  ) {
    return this.catalog.getSysConfServices(idSystem, idConfig);
  }

  @Roles('admin')
  @Put('systems/:idSystem/configs/:idConfig/installation-services')
  setSysConfServices(
    @Param('idSystem', ParseIntPipe) idSystem: number,
    @Param('idConfig', ParseIntPipe) idConfig: number,
    @Body() dto: SetSysConfInstallationServicesDto,
    @Req() req: Request,
  ) {
    return this.catalog.setSysConfServices(
      idSystem,
      idConfig,
      dto,
      req.user as AuthUser,
    );
  }

  @Roles('admin', 'operator')
  @Get('installation-price-profiles')
  findProfiles(
    @Query('includeInactive', new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
  ) {
    return this.catalog.findProfiles(includeInactive ?? true);
  }

  @Roles('admin', 'operator')
  @Get('installation-price-profiles/:id')
  findProfile(@Param('id', ParseIntPipe) id: number) {
    return this.catalog.findProfile(id);
  }

  @Roles('admin')
  @Post('installation-price-profiles')
  createProfile(
    @Body() dto: CreateInstallationPriceProfileDto,
    @Req() req: Request,
  ) {
    return this.catalog.createProfile(dto, req.user as AuthUser);
  }

  @Roles('admin')
  @Patch('installation-price-profiles/:id')
  updateProfile(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInstallationPriceProfileDto,
    @Req() req: Request,
  ) {
    return this.catalog.updateProfile(id, dto, req.user as AuthUser);
  }

  @Roles('admin')
  @Delete('installation-price-profiles/:id')
  removeProfile(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    return this.catalog.removeProfile(id, req.user as AuthUser);
  }
}
