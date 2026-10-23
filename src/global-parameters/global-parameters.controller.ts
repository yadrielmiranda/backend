import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  ParseEnumPipe,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { GlobalParametersService } from './global-parameters.service';
import { UpdateGlobalParameterDto } from './dto/update-global-parameter.dto';
import { Roles } from '@/auth/roles.decorator';
import { GlobalParameterKey } from '@prisma/client';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('Global Parameters')
@ApiBearerAuth()
@Controller('global-parameters')
export class GlobalParametersController {
  constructor(private readonly globalParametersService: GlobalParametersService) {}

  // ✅ READ: todos los usuarios autenticados
  @Get()  
  @ApiOperation({ summary: 'Get all global parameters' })
  findAll(@Req() req: Request) {
    return this.globalParametersService.findAll((req.user as AuthUser)?.role?.name === 'admin');
  }

  // 🔒 WRITE: solo admin
  @Patch(':key')
  @Roles('admin')
  @ApiOperation({ summary: 'Update a global parameter by its key' })
  update(
    @Param('key', new ParseEnumPipe(GlobalParameterKey)) key: GlobalParameterKey,
    @Body() dto: UpdateGlobalParameterDto,
  ) {
    return this.globalParametersService.update(key, dto);
  }
}
