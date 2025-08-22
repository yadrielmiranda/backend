import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  UseGuards,
  ParseEnumPipe,
} from '@nestjs/common';
import { GlobalParametersService } from './global-parameters.service';
import { UpdateGlobalParameterDto } from './dto/update-global-parameter.dto';
import { JwtAuthGuard } from 'src/auth/guards/auth/auth.guard';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/roles.decorator';
import { GlobalParameterKey } from '@prisma/client';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('Global Parameters')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard) // <-- Todos los endpoints requieren que el usuario esté logueado
@Controller('global-parameters')
export class GlobalParametersController {
  constructor(
    private readonly globalParametersService: GlobalParametersService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get all global parameters' })
  findAll() {
    return this.globalParametersService.findAll();
  }

  @Patch(':key')
  @UseGuards(RolesGuard) 
  @Roles('admin')        // Solo los admins pueden actualizar
  @ApiOperation({ summary: 'Update a global parameter by its key' })
  update(
    @Param('key', new ParseEnumPipe(GlobalParameterKey))
    key: GlobalParameterKey,
    @Body() updateGlobalParameterDto: UpdateGlobalParameterDto,
  ) {
    return this.globalParametersService.update(key, updateGlobalParameterDto);
  }
}
