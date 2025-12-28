import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  ParseEnumPipe,
} from '@nestjs/common';
import { GlobalParametersService } from './global-parameters.service';
import { UpdateGlobalParameterDto } from './dto/update-global-parameter.dto';
import { Roles } from 'src/auth/roles.decorator';
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
  findAll() {
    return this.globalParametersService.findAll(); 
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
