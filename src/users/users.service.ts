import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { User, Prisma } from '@prisma/client';
import * as bcrypt from "bcrypt";

@Injectable()
export class UsersService {

  constructor(private prisma: PrismaService) { }

  async user(
    userWhereUniqueInput: Prisma.UserWhereUniqueInput,
  ): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: userWhereUniqueInput,
    });
  }

  async findOneByIdentifier(identifier: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: {
        OR: [
          { username: identifier },
          { email: identifier },
        ],
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
    });
  }

  async createUser(data: Prisma.UserCreateInput): Promise<User> {
    const saltRounds = 10;
    data.password = await bcrypt.hash(data.password, saltRounds);

    return this.prisma.user.create({
      data,
    });
  }

async updateUser(params: {
  where: Prisma.UserWhereUniqueInput;
  data: Prisma.UserUpdateInput;
}): Promise<User> {
  const { where, data } = params;

  // Se asume que la contraseña NO se actualiza aquí,
  // ya que habrá un método dedicado para ello.

  try {
    return await this.prisma.user.update({
      data,
      where,
    });
  } catch (error) {
    // Manejo del error 404 por si el usuario no existe.
    throw new NotFoundException(`User with ID #${where.id} not found`);
  }
}

  async deleteUser(where: Prisma.UserWhereUniqueInput): Promise<User> {
    try {
      return await this.prisma.user.delete({
        where,
      });
    } catch (error) {
      // Si Prisma no encuentra el registro para borrar, lanza un error.
      // Lo capturamos y devolvemos un 404.
      throw new NotFoundException(`User with ID #${where.id} not found`);
    }
  }
}