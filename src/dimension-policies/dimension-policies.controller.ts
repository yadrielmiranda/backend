import { Controller, Get, Post, Patch, Delete, Param, Body, Query, ParseIntPipe } from '@nestjs/common';
import { DimensionPoliciesService } from './dimension-policies.service';
import { CreatePolicyDto, UpdatePolicyDto } from './dto/create-dimension-policy.dto';
import { BulkUpsertRulesDto } from './dto/rule.dto';

@Controller('dimension-policies')
export class DimensionPoliciesController {
  constructor(private svc: DimensionPoliciesService) {}

  @Post()
  create(@Body() dto: CreatePolicyDto) {
    return this.svc.createPolicy(dto);
  }

  @Get()
  list(
    @Query('idSystem') idSystem?: number,
    @Query('idConfig') idConfig?: number,
    @Query('idCrystal') idCrystal?: number,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.svc.listPolicies({
      idSystem: idSystem ? Number(idSystem) : undefined,
      idConfig: idConfig ? Number(idConfig) : undefined,
      idCrystal: idCrystal ? Number(idCrystal) : undefined,
      activeOnly: activeOnly === 'true',
    });
  }

  // 👇 Faltaba este endpoint (lo usa tu frontend)
  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getPolicy(id);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePolicyDto) {
    return this.svc.updatePolicy(id, dto);
  }

  @Delete(':id')
  del(@Param('id', ParseIntPipe) id: number) {
    return this.svc.deletePolicy(id);
  }

  @Post(':id/rules:bulk-upsert')
  bulkUpsert(@Param('id', ParseIntPipe) id: number, @Body() dto: BulkUpsertRulesDto) {
    return this.svc.bulkUpsertRules(id, dto);
  }

  // Preview/validate para UI Admin o para estimador
  @Get('preview')
  preview(
    @Query('idSystem', ParseIntPipe) idSystem: number,
    @Query('idConfig', ParseIntPipe) idConfig: number,
    @Query('idCrystal', ParseIntPipe) idCrystal: number,
    @Query('widthIn') widthIn: string,
    @Query('heightIn') heightIn: string,
  ) {
    return this.svc.previewValidate({
      idSystem,
      idConfig,
      idCrystal,
      widthIn: Number(widthIn),
      heightIn: Number(heightIn),
    });
  }
}
