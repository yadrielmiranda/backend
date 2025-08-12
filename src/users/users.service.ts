// src/users/users.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma, User } from '@prisma/client';
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
    return this.prisma.user.findFirst({
      where: {
        OR: [{ username: identifier }, { email: identifier }],
      },
      include: {
        role: true,
      },
    });
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
    
    // El objeto 'restOfUserData' ya contiene 'markupOverride' si se envió.
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

    // Lógica explícita para manejar el 'markupOverride'.
    // Si la propiedad 'markupOverride' existe en el DTO que recibimos...
    if ('markupOverride' in userData) {
      // ...la asignamos al payload que irá a Prisma.
      // Si el valor es un número, se guarda. Si es 'null', Prisma borrará el valor.
      dataForPrisma.markupOverride = userData.markupOverride;
    }

    try {
      return await this.prisma.user.update({
        data: dataForPrisma,
        where,
      });
    } catch (error) {
      // Imprime el error en la consola del backend para depuración
      console.error("Error updating user:", error);
      throw new NotFoundException(`User with ID #${where.id} not found or update failed.`);
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
