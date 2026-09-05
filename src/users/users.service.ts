import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { DealerMode, Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { LogsService } from '@/logs/logs.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { getRoleName } from '@/auth/utils/get-role-name';

export type UserSafe = Omit<User, 'password'> & {
  role: Prisma.RoleGetPayload<{
    include: { installationPriceProfile: true };
  }>;
  installationPriceProfile: Prisma.InstallationPriceProfileGetPayload<{}> | null;
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

  private normalizeMarkupOverride(value: string | null): Prisma.Decimal | null {
    if (value === null) return null;

    const markup = new Prisma.Decimal(value);

    if (markup.lte(-1)) {
      throw new BadRequestException(
        'Custom markup must be greater than -100%.',
      );
    }

    return markup;
  }

  private resolveDealerMode(params: {
    roleName: string;
    dealerMode?: DealerMode | null;
    fallbackMode?: DealerMode | null;
  }) {
    if (params.roleName !== 'dealer') return null;

    return params.dealerMode ?? params.fallbackMode ?? DealerMode.EXTERNAL;
  }

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
    dealerMode: true,
    isActive: true,
    deletedAt: true,
    idRole: true,
    installationPriceProfileId: true,
    installationPriceProfile: true,
    passwordUpdatedAt: true,
    createdAt: true,
    updatedAt: true,
    role: { include: { installationPriceProfile: true } },
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
      installationPriceProfileId: u.installationPriceProfileId ?? null,
      installationPriceProfileName: u.installationPriceProfile?.name ?? null,
      markupOverride: u.markupOverride ?? null,
      isTaxExempt: u.isTaxExempt ?? null,
      dealerMode: u.dealerMode ?? null,
      isActive: u.isActive ?? null,
      deletedAt: u.deletedAt ?? null,
      passwordUpdatedAt: u.passwordUpdatedAt ?? null,
    };
  }

  private diffChangedFields(
    before: UserSafe,
    after: UserSafe,
    dto: UpdateUserDto,
  ) {
    const changed: string[] = [];
    const cmp = (a: any, b: any) => (a ?? null) !== (b ?? null);

    if ('username' in dto && cmp(before.username, after.username))
      changed.push('username');
    if ('email' in dto && cmp(before.email, after.email)) changed.push('email');
    if ('firstName' in dto && cmp(before.firstName, after.firstName))
      changed.push('firstName');
    if ('lastName' in dto && cmp(before.lastName, after.lastName))
      changed.push('lastName');
    if ('phone' in dto && cmp(before.phone, after.phone)) changed.push('phone');
    if ('street' in dto && cmp(before.street, after.street))
      changed.push('street');
    if ('city' in dto && cmp(before.city, after.city)) changed.push('city');
    if ('state' in dto && cmp(before.state, after.state)) changed.push('state');
    if ('postalCode' in dto && cmp(before.postalCode, after.postalCode))
      changed.push('postalCode');
    if ('idRole' in dto && cmp(before.idRole, after.idRole))
      changed.push('idRole');
    if (
      'installationPriceProfileId' in dto &&
      cmp(before.installationPriceProfileId, after.installationPriceProfileId)
    ) {
      changed.push('installationPriceProfileId');
    }

    if (
      'markupOverride' in dto &&
      (before.markupOverride?.toString() ?? null) !==
        (after.markupOverride?.toString() ?? null)
    ) {
      changed.push('markupOverride');
    }

    if ('isTaxExempt' in dto && cmp(before.isTaxExempt, after.isTaxExempt)) {
      changed.push('isTaxExempt');
    }

    if ('dealerMode' in dto && cmp(before.dealerMode, after.dealerMode)) {
      changed.push('dealerMode');
    }

    if ('isActive' in dto && cmp(before.isActive, after.isActive)) {
      changed.push('isActive');
    }

    const passwordChanged = Boolean((dto as any)?.password);
    if (passwordChanged) changed.push('password');

    return { changedFields: changed, passwordChanged };
  }

  async userSafe(
    userWhereUniqueInput: Prisma.UserWhereUniqueInput,
  ): Promise<UserSafe> {
    const user = await this.prisma.user.findFirst({
      where: {
        ...userWhereUniqueInput,
        deletedAt: null,
      },
      select: this.safeSelect,
    });

    if (!user) {
      throw new NotFoundException(
        `User with ID #${userWhereUniqueInput.id} not found.`,
      );
    }

    return user as UserSafe;
  }

  async usersSafe(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.UserWhereUniqueInput;
    where?: Prisma.UserWhereInput;
    orderBy?: Prisma.UserOrderByWithRelationInput;
    includeDeleted?: boolean;
  }): Promise<UserSafe[]> {
    const { skip, take, cursor, where, orderBy } = params;

    const users = await this.prisma.user.findMany({
      skip,
      take,
      cursor,
      where: {
        ...(params.includeDeleted ? {} : { deletedAt: null }),
        ...(where ?? {}),
      },
      orderBy,
      select: this.safeSelect,
    });

    return users as UserSafe[];
  }

  async createUser(userData: CreateUserDto): Promise<UserSafe> {
    const { idRole, installationPriceProfileId, dealerMode, ...rest } =
      userData;
    const hashedPassword = await bcrypt.hash(rest.password, 10);

    const role = await this.prisma.role.findUnique({
      where: { id: idRole },
      select: { id: true, name: true },
    });
    if (!role) {
      throw new BadRequestException('The selected role does not exist.');
    }

    const resolvedDealerMode = this.resolveDealerMode({
      roleName: role.name,
      dealerMode,
    });

    if (installationPriceProfileId != null) {
      const profile = await this.prisma.installationPriceProfile.findFirst({
        where: { id: installationPriceProfileId, isActive: true },
        select: { id: true },
      });
      if (!profile) {
        throw new BadRequestException(
          'The selected installation price profile is unavailable.',
        );
      }
    }

    const created = await this.prisma.user.create({
      data: {
        ...rest,
        password: hashedPassword,
        dealerMode: resolvedDealerMode,
        role: { connect: { id: idRole } },
        ...(installationPriceProfileId
          ? {
              installationPriceProfile: {
                connect: { id: installationPriceProfileId },
              },
            }
          : {}),
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
    const {
      idRole,
      installationPriceProfileId,
      markupOverride,
      dealerMode,
      ...rest
    } = userData;

    const existing = await this.prisma.user.findFirst({
      where: {
        ...where,
        deletedAt: null,
      },
      select: {
        id: true,
        idRole: true,
        dealerMode: true,
        role: { select: { name: true } },
      },
    });

    if (!existing) {
      throw new NotFoundException(`User with ID #${where.id} not found.`);
    }

    const dataForPrisma: Prisma.UserUpdateInput = {
      ...rest,
    };

    let nextRoleName = existing.role.name;

    if (rest.password) {
      dataForPrisma.password = await bcrypt.hash(rest.password, 10);
      dataForPrisma.passwordUpdatedAt = new Date();
    }

    if (idRole) {
      const selectedRole = await this.prisma.role.findUnique({
        where: { id: idRole },
        select: { name: true },
      });
      if (!selectedRole) {
        throw new BadRequestException('The selected role does not exist.');
      }
      nextRoleName = selectedRole.name;
      dataForPrisma.role = { connect: { id: idRole } };
    }

    dataForPrisma.dealerMode = this.resolveDealerMode({
      roleName: nextRoleName,
      dealerMode,
      fallbackMode: existing.dealerMode,
    });

    if (installationPriceProfileId != null) {
      const profile = await this.prisma.installationPriceProfile.findFirst({
        where: { id: installationPriceProfileId, isActive: true },
        select: { id: true },
      });
      if (!profile) {
        throw new BadRequestException(
          'The selected installation price profile is unavailable.',
        );
      }
    }

    if (installationPriceProfileId !== undefined) {
      dataForPrisma.installationPriceProfile =
        installationPriceProfileId === null
          ? { disconnect: true }
          : { connect: { id: installationPriceProfileId } };
    }

    if (markupOverride !== undefined) {
      dataForPrisma.markupOverride =
        this.normalizeMarkupOverride(markupOverride);
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

  async createUserAsAdmin(
    userData: CreateUserDto,
    actor: AuthUser,
  ): Promise<UserSafe> {
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

    const { changedFields, passwordChanged } = this.diffChangedFields(
      before,
      updated,
      userData,
    );

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

  async deleteOwnUser(actor: AuthUser): Promise<UserSafe> {
    const actorRole = getRoleName(actor);

    if (actorRole === 'admin') {
      throw new BadRequestException('Admins cannot delete themselves.');
    }

    const before = await this.userSafe({ id: actor.id });

    const sessions = await this.prisma.session.findMany({
      where: { userId: actor.id, revokedAt: null },
      select: { id: true },
    });

    const deleted = await this.deleteUser({ id: actor.id });

    await this.logs.log({
      action: 'DELETE',
      entityType: 'User',
      entityId: before.id,
      userId: before.id,
      message: `User deleted own account (#${before.id})`,
      before: this.userSnapshot(before),
      after: this.userSnapshot(deleted),
      meta: {
        source: 'UsersService.deleteOwnUser',
        actorUserId: actor.id,
        actorRole,
        targetUserId: before.id,
        revokedSessionIds: sessions.map((s) => s.id),
      },
    });

    for (const s of sessions) {
      await this.logs.log({
        action: 'LOGOUT',
        entityType: 'Session',
        entityId: 0,
        userId: actor.id,
        message: `Session ended (user deleted own account) (sid: ${s.id})`,
        meta: {
          source: 'UsersService.deleteOwnUser',
          reason: 'USER_SELF_DELETED',
          sessionId: s.id,
          actorUserId: actor.id,
          actorRole,
          targetUserId: actor.id,
        },
      });
    }

    return deleted;
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

  async userWithPassword(
    where: Prisma.UserWhereUniqueInput,
  ): Promise<UserWithRoleAndPassword> {
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

  async findOneByIdentifier(
    identifier: string,
  ): Promise<UserWithRoleAndPassword | null> {
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
