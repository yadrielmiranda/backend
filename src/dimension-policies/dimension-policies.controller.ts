import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  ParseIntPipe,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { DimensionPoliciesService } from './dimension-policies.service';
import { CreatePolicyDto, UpdatePolicyDto } from './dto/create-dimension-policy.dto';
import { BulkUpsertRulesDto } from './dto/rule.dto';
import { DimensionRuleType } from '@prisma/client';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';

@Controller('dimension-policies')
export class DimensionPoliciesController {
  constructor(private svc: DimensionPoliciesService) { }

  // WRITE: solo admin
  @Post()
  @Roles('admin')
  create(@Body() dto: CreatePolicyDto, @Req() req: Request) {
    return this.svc.createPolicy(dto, req.user as AuthUser);
  }

  //  READ: todos los usuarios autenticados
  @Get()
  list(
    @Query('idSystem') idSystem?: string,
    @Query('idConfig') idConfig?: string,
    @Query('idCrystal') idCrystal?: string,
    @Query('idReinforcementOption') idReinforcementOption?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.svc.listPolicies({
      idSystem: idSystem ? Number(idSystem) : undefined,
      idConfig: idConfig ? Number(idConfig) : undefined,
      idCrystal: idCrystal ? Number(idCrystal) : undefined,
      idReinforcementOption:
        idReinforcementOption != null && idReinforcementOption !== ''
          ? Number(idReinforcementOption)
          : undefined,
      activeOnly: activeOnly === 'true',
    });
  }

  // READ: todos los usuarios autenticados
  @Get('preview')
  preview(
    @Query('idSystem', ParseIntPipe) idSystem: number,
    @Query('idConfig', ParseIntPipe) idConfig: number,
    @Query('idCrystal', ParseIntPipe) idCrystal: number,
    @Query('idReinforcementOption') idReinforcementOption: string | undefined,
    @Query('widthIn') widthIn: string,
    @Query('heightIn') heightIn: string,
    @Query('ruleType') ruleType?: DimensionRuleType,
  ) {
    return this.svc.previewValidate({
      idSystem,
      idConfig,
      idCrystal,
      idReinforcementOption:
        idReinforcementOption != null && idReinforcementOption !== ''
          ? Number(idReinforcementOption)
          : undefined,
      widthIn: Number(widthIn),
      heightIn: Number(heightIn),
      ruleType,
    });
  }

  // READ: todos los usuarios autenticados
  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getPolicy(id);
  }

  // WRITE: solo admin
  @Patch(':id')
  @Roles('admin')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePolicyDto,
    @Req() req: Request,
  ) {
    return this.svc.updatePolicy(id, dto, req.user as AuthUser);
  }

  // WRITE: solo admin
  @Delete(':id')
  @Roles('admin')
  del(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.svc.deletePolicy(id, req.user as AuthUser);
  }

  // WRITE: solo admin
  @Post(':id/rules/bulk-upsert')
  @Roles('admin')
  bulkUpsert(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: BulkUpsertRulesDto,
    @Req() req: Request,
  ) {
    return this.svc.bulkUpsertRules(id, dto, req.user as AuthUser);
  }
}
