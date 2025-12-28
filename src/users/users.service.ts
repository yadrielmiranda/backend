// src/users/users.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

export type UserSafe = Omit<User, 'password'> & {
  role: { id: number; name: string; markup: Prisma.Decimal };
};

type UserWithRoleAndPassword = Prisma.UserGetPayload<{
  include: { role: true };
}>;

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  // ✅ SELECT “safe”: NUNCA trae password
  private readonly safeSelect = {
    id: true,
    username: true,
    firstName: true,
    lastName: true,
    email: true,
    phone: true,
    street: true,
    city: true,
    state: true,
    postalCode: true,
    markupOverride: true,
    isTaxExempt: true,
    idRole: true,
    role: true,
  } satisfies Prisma.UserSelect;

  // ------------------------------------------------------------
  // ✅ Métodos SAFE (para controllers)
  // ------------------------------------------------------------

  async userSafe(
    userWhereUniqueInput: Prisma.UserWhereUniqueInput,
  ): Promise<UserSafe> {
    const user = await this.prisma.user.findUnique({
      where: userWhereUniqueInput,
      select: this.safeSelect,
    });

    if (!user) throw new NotFoundException(`User with ID #${userWhereUniqueInput.id} not found.`);
    return user as UserSafe;
  }

  async usersSafe(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.UserWhereUniqueInput;
    where?: Prisma.UserWhereInput;
    orderBy?: Prisma.UserOrderByWithRelationInput;
  }): Promise<UserSafe[]> {
    const { skip, take, cursor, where, orderBy } = params;
    const users = await this.prisma.user.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
      select: this.safeSelect,
    });
    return users as UserSafe[];
  }

  async createUser(userData: CreateUserDto): Promise<UserSafe> {
    const { idRole, ...rest } = userData;

    const hashedPassword = await bcrypt.hash(rest.password, 10);

    const created = await this.prisma.user.create({
      data: {
        ...rest,
        password: hashedPassword,
        role: { connect: { id: idRole } },
      },
      select: this.safeSelect,
    });

    return created as UserSafe;
  }

  async updateUser(params: {
    where: Prisma.UserWhereUniqueInput;
    data: UpdateUserDto;
  }): Promise<UserSafe> {
    const { where, data: userData } = params;
    const { idRole, ...rest } = userData;

    const dataForPrisma: Prisma.UserUpdateInput = {
      ...rest,
    };

    if (rest.password) {
      dataForPrisma.password = await bcrypt.hash(rest.password, 10);
    }

    if (idRole) {
      dataForPrisma.role = { connect: { id: idRole } };
    }

    // Manejo explícito de markupOverride (si viene en el payload)
    if ('markupOverride' in userData) {
      dataForPrisma.markupOverride = userData.markupOverride;
    }

    try {
      const updated = await this.prisma.user.update({
        where,
        data: dataForPrisma,
        select: this.safeSelect,
      });

      return updated as UserSafe;
    } catch (error) {
      console.error('Error updating user:', error);
      throw new NotFoundException(`User with ID #${where.id} not found or update failed.`);
    }
  }

  async deleteUser(where: Prisma.UserWhereUniqueInput): Promise<UserSafe> {
    try {
      const deleted = await this.prisma.user.delete({
        where,
        select: this.safeSelect,
      });
      return deleted as UserSafe;
    } catch (error) {
      throw new NotFoundException(`User with ID #${where.id} not found`);
    }
  }

  // ------------------------------------------------------------
  // 🔐 Métodos INTERNOS (para Auth)
  // ------------------------------------------------------------

  // ✅ Necesario para cambiar contraseña (bcrypt.compare)
  async userWithPassword(where: Prisma.UserWhereUniqueInput): Promise<UserWithRoleAndPassword> {
    const user = await this.prisma.user.findUnique({
      where,
      include: { role: true },
    });
    if (!user) throw new NotFoundException(`User with ID #${where.id} not found.`);
    return user;
  }

  // ✅ Necesario para login (trae password hash)
  async findOneByIdentifier(identifier: string): Promise<UserWithRoleAndPassword | null> {
    return this.prisma.user.findFirst({
      where: {
        OR: [{ username: identifier }, { email: identifier }],
      },
      include: { role: true },
    });
  }
}
