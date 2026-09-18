import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { SaveInstallationCoverageDto } from './dto/installation-coverage.dto';
import { InstallationCoverageService } from './installation-coverage.service';

@Roles('admin')
@Controller('installation-coverage')
export class InstallationCoverageController {
  constructor(private readonly coverage: InstallationCoverageService) {}

  @Get()
  async find() {
    return { configuration: await this.coverage.find() };
  }

  @Put()
  save(@Body() dto: SaveInstallationCoverageDto, @Req() request: Request) {
    return this.coverage.save(dto, (request.user as AuthUser).id);
  }
}
