import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { LogsService } from '@/logs/logs.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { getRoleName } from '@/auth/utils/get-role-name';

export type UserSafe = Omit<User, 'password'> & {
  role: { id: number; name: string; markup: Prisma.Decimal };
};

type UserWithRoleAndPassword = Prisma.UserGetPayload<{
  include: { role: true };
}>;

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private logs: LogsService,
  ) {}

  //  SELECT “safe”: NUNCA trae password
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
    passwordUpdatedAt: true,
    createdAt: true,
    updatedAt: true,
    role: true,
  } satisfies Prisma.UserSelect;

  // =====================================================
  // Helpers
  // =====================================================

  //  snapshot "safe" para before/after (no incluye password)
  private userSnapshot(u: UserSafe) {
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      phone: u.phone,
      street: u.street,
      city: u.city,
      state: u.state,
      postalCode: u.postalCode,
      idRole: u.idRole,
      roleName: u.role?.name ?? null,
      markupOverride: u.markupOverride ?? null,
      isTaxExempt: u.isTaxExempt ?? null,
      passwordUpdatedAt: u.passwordUpdatedAt ?? null,
    };
  }

  private diffChangedFields(before: UserSafe, after: UserSafe, dto: UpdateUserDto) {
    //  solo auditamos campos que vinieron en el DTO
    const changed: string[] = [];
    const cmp = (a: any, b: any) => (a ?? null) !== (b ?? null);

    if ('username' in dto && cmp(before.username, after.username)) changed.push('username');
    if ('email' in dto && cmp(before.email, after.email)) changed.push('email');
    if ('firstName' in dto && cmp(before.firstName, after.firstName)) changed.push('firstName');
    if ('lastName' in dto && cmp(before.lastName, after.lastName)) changed.push('lastName');
    if ('phone' in dto && cmp(before.phone, after.phone)) changed.push('phone');
    if ('street' in dto && cmp(before.street, after.street)) changed.push('street');
    if ('city' in dto && cmp(before.city, after.city)) changed.push('city');
    if ('state' in dto && cmp(before.state, after.state)) changed.push('state');
    if ('postalCode' in dto && cmp(before.postalCode, after.postalCode)) changed.push('postalCode');
    if ('idRole' in dto && cmp(before.idRole, after.idRole)) changed.push('idRole');

    if ('markupOverride' in dto && cmp(before.markupOverride, after.markupOverride))
      changed.push('markupOverride');

    if ('isTaxExempt' in dto && cmp(before.isTaxExempt, after.isTaxExempt))
      changed.push('isTaxExempt');

    // comentario en espanol: password se marca como cambio sin guardar el valor
    const passwordChanged = Boolean((dto as any)?.password);
    if (passwordChanged) changed.push('password');

    return { changedFields: changed, passwordChanged };
  }

  // =====================================================
  // CRUD "safe" existentes
  // =====================================================

  async userSafe(userWhereUniqueInput: Prisma.UserWhereUniqueInput): Promise<UserSafe> {
    const user = await this.prisma.user.findUnique({
      where: userWhereUniqueInput,
      select: this.safeSelect,
    });

    if (!user)
      throw new NotFoundException(`User with ID #${userWhereUniqueInput.id} not found.`);

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
      dataForPrisma.passwordUpdatedAt = new Date();
    }

    if (idRole) {
      dataForPrisma.role = { connect: { id: idRole } };
    }

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
      // comentario en espanol: mantenemos el mismo comportamiento de antes
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

  // =====================================================
  //  ADMIN wrappers: logs + before/after + revoke sessions
  // =====================================================

  async createUserAsAdmin(userData: CreateUserDto, actor: AuthUser): Promise<UserSafe> {
    const created = await this.createUser(userData);

    await this.logs.log({
      action: 'CREATE',
      entityType: 'User',
      entityId: created.id,
      userId: actor.id, //  admin que creó
      message: `User created (#${created.id})`,
      after: this.userSnapshot(created),
      meta: {
        source: 'UsersService.createUserAsAdmin',
        actorUserId: actor.id,
        actorRole: getRoleName(actor) ?? null,
      },
    });

    return created;
  }

  async updateUserAsAdmin(
    userId: number,
    userData: UpdateUserDto,
    actor: AuthUser,
  ): Promise<UserSafe> {
    // 1) before
    const before = await this.userSafe({ id: userId });

    // 2) update
    const updated = await this.updateUser({
      where: { id: userId },
      data: userData,
    });

    // 3) diff + log UPDATE
    const { changedFields, passwordChanged } = this.diffChangedFields(before, updated, userData);

    await this.logs.log({
      action: 'UPDATE',
      entityType: 'User',
      entityId: updated.id,
      userId: actor.id,
      message: `User updated (#${updated.id})`,
      before: this.userSnapshot(before),
      after: this.userSnapshot(updated),
      meta: {
        source: 'UsersService.updateUserAsAdmin',
        actorUserId: actor.id,
        actorRole: getRoleName(actor) ?? null,
        changedFields,
        targetUserId: updated.id,
      },
    });

    // 4) si password cambió => revocar sesiones + LOGOUT por cada una
    if (passwordChanged) {
      const sessions = await this.prisma.session.findMany({
        where: { userId, revokedAt: null },
        select: { id: true },
      });

      await this.prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      for (const s of sessions) {
        await this.logs.log({
          action: 'LOGOUT',
          entityType: 'Session',
          entityId: 0, // entityId es Int requerido; el sessionId (UUID) va en meta
          userId: userId, // dueño de la sesión
          message: `Session ended (password changed by admin) (sid: ${s.id})`,
          meta: {
            source: 'UsersService.updateUserAsAdmin',
            reason: 'PASSWORD_CHANGED',
            sessionId: s.id,
            actorUserId: actor.id,
            actorRole: getRoleName(actor) ?? null,
            targetUserId: userId,
          },
        });
      }
    }

    return updated;
  }

  async deleteUserAsAdmin(userId: number, actor: AuthUser): Promise<UserSafe> {
    // comentario en espanol: tomamos before para log, luego borramos
    const before = await this.userSafe({ id: userId });
    const deleted = await this.deleteUser({ id: userId });

    await this.logs.log({
      action: 'DELETE',
      entityType: 'User',
      entityId: before.id,
      userId: actor.id,
      message: `User deleted (#${before.id})`,
      before: this.userSnapshot(before),
      meta: {
        source: 'UsersService.deleteUserAsAdmin',
        actorUserId: actor.id,
        actorRole: getRoleName(actor) ?? null,
        targetUserId: before.id,
      },
    });

    return deleted;
  }

  // ------------------------------------------------------------
  //  Métodos INTERNOS (para Auth)
  // ------------------------------------------------------------

  async userWithPassword(where: Prisma.UserWhereUniqueInput): Promise<UserWithRoleAndPassword> {
    const user = await this.prisma.user.findUnique({
      where,
      include: { role: true },
    });
    if (!user) throw new NotFoundException(`User with ID #${where.id} not found.`);
    return user;
  }

  async findOneByIdentifier(identifier: string): Promise<UserWithRoleAndPassword | null> {
    return this.prisma.user.findFirst({
      where: {
        OR: [{ username: identifier }, { email: identifier }],
      },
      include: { role: true },
    });
  }
}
