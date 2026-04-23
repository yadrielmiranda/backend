import { Controller, Get, Patch, Param, Body, ParseIntPipe, Req } from '@nestjs/common';
import { Request } from 'express';
import { RolesService } from './roles.service';
import { UpdateRoleDto } from './dto/update-role.dto';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';

@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Roles('admin', 'operator')
  @Get()
  findAll() {
    return this.rolesService.findAll();
  }

  @Roles('admin')
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateRoleDto: UpdateRoleDto,
    @Req() req: Request,
  ) {
    return this.rolesService.update(id, updateRoleDto, req.user as AuthUser);
  }
}
