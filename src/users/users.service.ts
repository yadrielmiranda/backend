import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {  Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async user(
    userWhereUniqueInput: Prisma.UserWhereUniqueInput,
  ): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: userWhereUniqueInput,     
      include: {
        role: true,
      },
    });
  }

  async findOneByIdentifier(identifier: string): Promise<User | null> {
    const user = this.prisma.user.findFirst({
      where: {
        OR: [{ username: identifier }, { email: identifier }],
      },      
      include: {
        role: true,
      },
    });
    return user;
  }

  async users(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.UserWhereUniqueInput;
    where?: Prisma.UserWhereInput;
    orderBy?: Prisma.UserOrderByWithRelationInput;
  }): Promise<User[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.user.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
      // ✅ CORRECCIÓN: Se añade 'include' para traer los datos del rol de cada usuario.
      include: {
        role: true,
      },
    });
  }

  async createUser(userData: CreateUserDto): Promise<User> {
    const { idRole, ...restOfUserData } = userData;
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(
      restOfUserData.password,
      saltRounds,
    );
    const dataForPrisma: Prisma.UserCreateInput = {
      ...restOfUserData,
      password: hashedPassword,
      role: {
        connect: {
          id: idRole,
        },
      },
    };
    return this.prisma.user.create({
      data: dataForPrisma,
    });
  }

  async updateUser(params: {
    where: Prisma.UserWhereUniqueInput;
    data: UpdateUserDto;
  }): Promise<User> {
    const { where, data: userData } = params;
    const { idRole, ...restOfUserData } = userData;
    const dataForPrisma: Prisma.UserUpdateInput = {
      ...restOfUserData,
    };
    if (restOfUserData.password) {
      const saltRounds = 10;
      dataForPrisma.password = await bcrypt.hash(
        restOfUserData.password,
        saltRounds,
      );
    }
    if (idRole) {
      dataForPrisma.role = {
        connect: {
          id: idRole,
        },
      };
    }
    try {
      return await this.prisma.user.update({
        data: dataForPrisma,
        where,
      });
    } catch (error) {
      throw new NotFoundException(`User with ID #${where.id} not found`);
    }
  }

  async deleteUser(where: Prisma.UserWhereUniqueInput): Promise<User> {
    try {
      return await this.prisma.user.delete({
        where,
      });
    } catch (error) {
      throw new NotFoundException(`User with ID #${where.id} not found`);
    }
  }
}
