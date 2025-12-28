import { Controller, Get, Patch, Param, Body, ParseIntPipe } from '@nestjs/common';
import { RolesService } from './roles.service';
import { UpdateRoleDto } from './dto/update-role.dto'; 
import { Roles } from 'src/auth/roles.decorator';


@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  findAll() {
    return this.rolesService.findAll();
  }
  
  @Roles('admin')
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateRoleDto: UpdateRoleDto,
  ) {
    return this.rolesService.update(id, updateRoleDto);
  }
}