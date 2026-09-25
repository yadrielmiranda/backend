import { BadRequestException, Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, ParseIntPipe, Patch, Post, Req } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { DealerEarningsBasis, Prisma } from '@prisma/client';
import { PrismaModule } from '@/prisma/prisma.module';
import { PrismaService } from '@/prisma/prisma.service';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { earningsPlanSnapshot, validateEarningsRule } from './earnings-plan';

export class SaveEarningsPlanDto {
  @IsString() @MinLength(1) @MaxLength(100)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  name: string;

  @IsEnum(DealerEarningsBasis) basis: DealerEarningsBasis;

  @Transform(({ value }) => value == null ? value : String(value).trim())
  @IsString() @Matches(/^\d{1,3}(?:\.\d{1,4})?$/)
  percent: string;

  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Injectable()
export class EarningsPlansService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.dealerEarningsPlan.findMany({
      orderBy: { name: 'asc' }, include: { _count: { select: { users: true } } },
    });
  }

  async remove(id: number, actorId: number) {
    const assignedMessage = 'Assign another plan to its dealers before deleting this plan.';
    try {
      return await this.prisma.$transaction(async db => {
        // Comparte el bloqueo usado al asignar planes.
        await db.$queryRaw`SELECT id FROM DealerEarningsPlan WHERE id = ${id} FOR UPDATE`;
        const before = await db.dealerEarningsPlan.findUnique({ where: { id } });
        if (!before) throw new NotFoundException('Earnings plan not found.');
        if (await db.user.count({ where: { dealerEarningsPlanId: id } }))
          throw new BadRequestException(assignedMessage);
        await db.dealerEarningsPlan.delete({ where: { id } });
        await db.eventLog.create({ data: {
          action: 'DELETE', entityType: 'DealerEarningsPlan', entityId: id, userId: actorId,
          message: `Earnings plan ${before.name} deleted.`,
          tempLog: { create: {
            before: { ...earningsPlanSnapshot(before), isActive: before.isActive },
            after: Prisma.JsonNull,
          } },
        } });
        return { id };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003')
        throw new BadRequestException(assignedMessage);
      throw error;
    }
  }

  async save(dto: SaveEarningsPlanDto, actorId: number, id?: number) {
    const name = dto.name?.trim();
    if (!name || name.length > 100) throw new BadRequestException('Enter a plan name with 1 to 100 characters.');
    const rule = validateEarningsRule(dto.basis, dto.percent);
    try {
      return await this.prisma.$transaction(async db => {
        if (id != null) await db.$queryRaw`SELECT id FROM DealerEarningsPlan WHERE id = ${id} FOR UPDATE`;
        const before = id == null ? null : await db.dealerEarningsPlan.findUnique({ where: { id } });
        if (id != null && !before) throw new NotFoundException('Earnings plan not found.');
        const owners = id == null ? [] : await db.user.findMany({ where: { dealerEarningsPlanId: id }, select: { id: true } });
        if (dto.isActive === false && owners.length)
          throw new BadRequestException('Assign another plan to its dealers before deactivating this plan.');
        const changed = before && (before.name !== name || before.basis !== rule.basis || !before.percent.eq(rule.percent));
        const data = {
          name, basis: rule.basis, percent: new Prisma.Decimal(rule.percent),
          isActive: dto.isActive ?? before?.isActive ?? true,
          revision: (before?.revision ?? 1) + (changed ? 1 : 0),
        };
        const result = id == null
          ? await db.dealerEarningsPlan.create({ data, include: { _count: { select: { users: true } } } })
          : await db.dealerEarningsPlan.update({ where: { id }, data, include: { _count: { select: { users: true } } } });
        await db.eventLog.create({ data: {
          action: id == null ? 'CREATE' : 'UPDATE', entityType: 'DealerEarningsPlan', entityId: result.id, userId: actorId,
          message: `Earnings plan ${result.name} saved.`,
          tempLog: { create: {
            before: before ? { ...earningsPlanSnapshot(before), isActive: before.isActive } : Prisma.JsonNull,
            after: { ...earningsPlanSnapshot(result), isActive: result.isActive },
          } },
        } });
        return result;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new BadRequestException('An earnings plan with this name already exists.');
      throw error;
    }
  }
}

@Controller('earnings-plans')
@Roles('admin')
export class EarningsPlansController {
  constructor(private readonly service: EarningsPlansService) {}
  @Get() list() { return this.service.list(); }
  @Post() create(@Body() dto: SaveEarningsPlanDto, @Req() req: { user: AuthUser }) {
    return this.service.save(dto, req.user.id);
  }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: SaveEarningsPlanDto, @Req() req: { user: AuthUser }) {
    return this.service.save(dto, req.user.id, id);
  }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number, @Req() req: { user: AuthUser }) {
    return this.service.remove(id, req.user.id);
  }
}

@Module({ imports: [PrismaModule], controllers: [EarningsPlansController], providers: [EarningsPlansService] })
export class EarningsPlansModule {}
