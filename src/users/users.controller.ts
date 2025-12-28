import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { UsersService, UserSafe } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from 'src/auth/guards/auth/auth.guard';
import { Roles } from 'src/auth/roles.decorator';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @Roles('admin')
  @UseGuards(RolesGuard)
  async createUser(@Body() userData: CreateUserDto): Promise<UserSafe> {
    return this.usersService.createUser(userData);
  }

  @Get()
  @Roles('admin', 'operator')
  @UseGuards(RolesGuard)
  async getAllUsers(): Promise<UserSafe[]> {
    return this.usersService.usersSafe({});
  }

  @Get(':id')
  @Roles('admin', 'operator')
  @UseGuards(RolesGuard)
  async getUser(@Param('id', ParseIntPipe) id: number): Promise<UserSafe> {
    return this.usersService.userSafe({ id });
  }

  @Patch(':id')
  @Roles('admin')
  @UseGuards(RolesGuard)
  async updateUser(
    @Param('id', ParseIntPipe) id: number,
    @Body() userData: UpdateUserDto,
  ): Promise<UserSafe> {
    return this.usersService.updateUser({
      where: { id },
      data: userData,
    });
  }

  @Delete(':id')
  @Roles('admin')
  @UseGuards(RolesGuard)
  async deleteUser(@Param('id', ParseIntPipe) id: number): Promise<UserSafe> {
    return this.usersService.deleteUser({ id });
  }
}
