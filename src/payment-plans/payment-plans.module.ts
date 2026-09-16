import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '@/prisma/prisma.module';
import { PrismaService } from '@/prisma/prisma.service';
import { Roles } from '@/auth/roles.decorator';
import { PlanDefinition, validatePlan } from './payment-plan';

class SavePaymentPlanDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name: string;
  @IsObject() definition: PlanDefinition;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Controller('payment-plans')
@Roles('admin')
class PaymentPlansController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() {
    return this.prisma.paymentPlan.findMany({ orderBy: { id: 'asc' } });
  }
  @Post() create(@Body() dto: SavePaymentPlanDto, @Req() req: any) {
    return this.save(dto, req.user.id);
  }
  @Patch(':id') update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SavePaymentPlanDto,
    @Req() req: any,
  ) {
    return this.save(dto, req.user.id, id);
  }
  private async save(dto: SavePaymentPlanDto, actorId: number, id?: number) {
    const definition = validatePlan(dto.definition);
    return this.prisma.$transaction(async (db) => {
      const before = id
        ? await db.paymentPlan.findUnique({ where: { id } })
        : null;
      if (id && !before) throw new NotFoundException('Payment plan not found.');
      if (
        await db.paymentPlan.findFirst({
          where: { name: dto.name, ...(id ? { id: { not: id } } : {}) },
        })
      )
        throw new BadRequestException(
          'A payment plan with this name already exists.',
        );
      if (
        dto.isActive === false &&
        id &&
        ((await db.user.count({ where: { paymentPlanId: id } })) ||
          (await db.role.count({ where: { paymentPlanId: id } })))
      )
        throw new BadRequestException(
          'Assign another plan to its users and roles before archiving this plan.',
        );
      const data = {
        name: dto.name,
        definition: definition as unknown as Prisma.InputJsonValue,
        isActive: dto.isActive ?? true,
      };
      const result = id
        ? await db.paymentPlan.update({ where: { id }, data })
        : await db.paymentPlan.create({ data });
      await db.eventLog.create({
        data: {
          action: id ? 'UPDATE' : 'CREATE',
          entityType: 'PaymentPlan',
          entityId: result.id,
          userId: actorId,
          message: `Payment plan ${result.name} saved. Existing estimates keep their agreed plan.`,
        },
      });
      return result;
    });
  }
}

@Module({ imports: [PrismaModule], controllers: [PaymentPlansController] })
export class PaymentPlansModule {}

export async function assertPaymentPlanAvailable(
  db: Prisma.TransactionClient,
  id?: number | null,
) {
  if (
    id != null &&
    !(await db.paymentPlan.findFirst({
      where: { id, isActive: true },
      select: { id: true },
    }))
  )
    throw new BadRequestException('The selected payment plan is unavailable.');
}
