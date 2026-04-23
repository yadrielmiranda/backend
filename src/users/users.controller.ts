// @/users/users.controller.ts
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
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { UsersService, UserSafe } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import { Roles } from '@/auth/roles.decorator';
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import type { AuthUser } from '@/auth/types/auth-user.type';

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @Roles('admin')
  @UseGuards(RolesGuard)
  async createUser(@Body() userData: CreateUserDto, @Req() req: Request): Promise<UserSafe> {
    return this.usersService.createUserAsAdmin(userData, req.user as AuthUser);
  }

  @Get()
  @Roles('admin')
  @UseGuards(RolesGuard)
  async getAllUsers(): Promise<UserSafe[]> {
    return this.usersService.usersSafe({});
  }

  @Get(':id')
  @Roles('admin')
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
    @Req() req: Request,
  ): Promise<UserSafe> {
    return this.usersService.updateUserAsAdmin(id, userData, req.user as AuthUser);
  }

  @Delete(':id')
  @Roles('admin')
  @UseGuards(RolesGuard)
  async deleteUser(@Param('id', ParseIntPipe) id: number, @Req() req: Request): Promise<UserSafe> {
    return this.usersService.deleteUserAsAdmin(id, req.user as AuthUser);
  }
}
