import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
  ) { }

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
    isActive: true,
    deletedAt: true,
    idRole: true,
    passwordUpdatedAt: true,
    createdAt: true,
    updatedAt: true,
    role: true,
  } satisfies Prisma.UserSelect;

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
      isActive: u.isActive ?? null,
      deletedAt: u.deletedAt ?? null,
      passwordUpdatedAt: u.passwordUpdatedAt ?? null,
    };
  }

  private diffChangedFields(before: UserSafe, after: UserSafe, dto: UpdateUserDto) {
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

    if ('markupOverride' in dto && cmp(before.markupOverride, after.markupOverride)) {
      changed.push('markupOverride');
    }

    if ('isTaxExempt' in dto && cmp(before.isTaxExempt, after.isTaxExempt)) {
      changed.push('isTaxExempt');
    }

    if ('isActive' in dto && cmp(before.isActive, after.isActive)) {
      changed.push('isActive');
    }

    const passwordChanged = Boolean((dto as any)?.password);
    if (passwordChanged) changed.push('password');

    return { changedFields: changed, passwordChanged };
  }

  async userSafe(userWhereUniqueInput: Prisma.UserWhereUniqueInput): Promise<UserSafe> {
    const user = await this.prisma.user.findFirst({
      where: {
        ...userWhereUniqueInput,
        deletedAt: null,
      },
      select: this.safeSelect,
    });

    if (!user) {
      throw new NotFoundException(`User with ID #${userWhereUniqueInput.id} not found.`);
    }

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
      where: {
        deletedAt: null,
        ...(where ?? {}),
      },
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

    const existing = await this.prisma.user.findFirst({
      where: {
        ...where,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException(`User with ID #${where.id} not found.`);
    }

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

    const updated = await this.prisma.user.update({
      where,
      data: dataForPrisma,
      select: this.safeSelect,
    });

    return updated as UserSafe;
  }

  async deleteUser(where: Prisma.UserWhereUniqueInput): Promise<UserSafe> {
    const userId = where.id;

    if (!userId) {
      throw new BadRequestException('User id is required.');
    }

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          email: true,
          phone: true,
          deletedAt: true,
        },
      });

      if (!user || user.deletedAt) {
        throw new NotFoundException(`User with ID #${userId} not found.`);
      }

      const now = new Date();

      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });

      await tx.branding.updateMany({
        where: { userId },
        data: { isActive: false },
      });

      const deleted = await tx.user.update({
        where: { id: userId },
        data: {
          isActive: false,
          deletedAt: now,
          username: `deleted_${user.id}_${user.username}`,
          email: `deleted_${user.id}_${user.email}`,
          phone: `+1000000${String(user.id).padStart(4, '0')}`,
        },
        select: this.safeSelect,
      });

      return deleted as UserSafe;
    });
  }

  async createUserAsAdmin(userData: CreateUserDto, actor: AuthUser): Promise<UserSafe> {
    const created = await this.createUser(userData);

    await this.logs.log({
      action: 'CREATE',
      entityType: 'User',
      entityId: created.id,
      userId: actor.id,
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
    if (userId === actor.id && userData.isActive === false) {
      throw new BadRequestException('You cannot deactivate your own user.');
    }

    const before = await this.userSafe({ id: userId });

    const updated = await this.updateUser({
      where: { id: userId },
      data: userData,
    });

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
          entityId: 0,
          userId,
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

  async setUserActiveAsAdmin(
    userId: number,
    isActive: boolean,
    actor: AuthUser,
  ): Promise<UserSafe> {
    if (userId === actor.id && !isActive) {
      throw new BadRequestException('You cannot deactivate your own user.');
    }

    const before = await this.userSafe({ id: userId });

    const updated = await this.updateUser({
      where: { id: userId },
      data: { isActive },
    });

    if (!isActive) {
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
          entityId: 0,
          userId,
          message: `Session ended (user deactivated by admin) (sid: ${s.id})`,
          meta: {
            source: 'UsersService.setUserActiveAsAdmin',
            reason: 'USER_DEACTIVATED',
            sessionId: s.id,
            actorUserId: actor.id,
            actorRole: getRoleName(actor) ?? null,
            targetUserId: userId,
          },
        });
      }
    }

    await this.logs.log({
      action: 'UPDATE',
      entityType: 'User',
      entityId: updated.id,
      userId: actor.id,
      message: isActive
        ? `User activated (#${updated.id})`
        : `User deactivated (#${updated.id})`,
      before: this.userSnapshot(before),
      after: this.userSnapshot(updated),
      meta: {
        source: 'UsersService.setUserActiveAsAdmin',
        actorUserId: actor.id,
        actorRole: getRoleName(actor) ?? null,
        targetUserId: updated.id,
        changedFields: ['isActive'],
      },
    });

    return updated;
  }

  async deleteUserAsAdmin(userId: number, actor: AuthUser): Promise<UserSafe> {
    if (userId === actor.id) {
      throw new BadRequestException('You cannot delete your own user.');
    }

    const before = await this.userSafe({ id: userId });

    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      select: { id: true },
    });

    const deleted = await this.deleteUser({ id: userId });

    await this.logs.log({
      action: 'DELETE',
      entityType: 'User',
      entityId: before.id,
      userId: actor.id,
      message: `User deleted (#${before.id})`,
      before: this.userSnapshot(before),
      after: this.userSnapshot(deleted),
      meta: {
        source: 'UsersService.deleteUserAsAdmin',
        actorUserId: actor.id,
        actorRole: getRoleName(actor) ?? null,
        targetUserId: before.id,
        revokedSessionIds: sessions.map((s) => s.id),
      },
    });

    for (const s of sessions) {
      await this.logs.log({
        action: 'LOGOUT',
        entityType: 'Session',
        entityId: 0,
        userId,
        message: `Session ended (user deleted by admin) (sid: ${s.id})`,
        meta: {
          source: 'UsersService.deleteUserAsAdmin',
          reason: 'USER_DELETED',
          sessionId: s.id,
          actorUserId: actor.id,
          actorRole: getRoleName(actor) ?? null,
          targetUserId: userId,
        },
      });
    }

    return deleted;
  }

  async userWithPassword(where: Prisma.UserWhereUniqueInput): Promise<UserWithRoleAndPassword> {
    const user = await this.prisma.user.findFirst({
      where: {
        ...where,
        deletedAt: null,
        isActive: true,
      },
      include: { role: true },
    });

    if (!user) {
      throw new NotFoundException(`User with ID #${where.id} not found.`);
    }

    return user;
  }

  async findOneByIdentifier(identifier: string): Promise<UserWithRoleAndPassword | null> {
    return this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        isActive: true,
        OR: [{ username: identifier }, { email: identifier }],
      },
      include: { role: true },
    });
  }
}