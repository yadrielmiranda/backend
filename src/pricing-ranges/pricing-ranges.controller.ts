import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { Request } from "express";

import { Roles } from "@/auth/roles.decorator";
import type { AuthUser } from "@/auth/types/auth-user.type";

import { PricingRangesService } from "./pricing-ranges.service";
import { CreatePricingRangeDto } from "./dto/create-pricing-range.dto";
import { FindPricingRangesQueryDto } from "./dto/find-pricing-ranges-query.dto";
import { UpdatePricingRangeDto } from "./dto/update-pricing-range.dto";
import { UpsertPricingRangeRuleDto } from "./dto/upsert-pricing-range-rule.dto";

@Controller("pricing-ranges")
export class PricingRangesController {
  constructor(private readonly pricingRangesService: PricingRangesService) {}

  @Get()
  @Roles("admin", "operator")
  findAll(@Query() query: FindPricingRangesQueryDto) {
    return this.pricingRangesService.findAll(query);
  }

  @Get(":id")
  @Roles("admin", "operator")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.pricingRangesService.findOne(id);
  }

  @Post()
  @Roles("admin")
  create(@Body() dto: CreatePricingRangeDto, @Req() req: Request) {
    return this.pricingRangesService.create(dto, req.user as AuthUser);
  }

  @Patch(":id")
  @Roles("admin")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdatePricingRangeDto,
    @Req() req: Request,
  ) {
    return this.pricingRangesService.update(id, dto, req.user as AuthUser);
  }

  @Delete(":id")
  @Roles("admin")
  remove(@Param("id", ParseIntPipe) id: number, @Req() req: Request) {
    return this.pricingRangesService.remove(id, req.user as AuthUser);
  }

  @Put(":rangeId/rules")
  @Roles("admin")
  upsertRule(
    @Param("rangeId", ParseIntPipe) rangeId: number,
    @Body() dto: UpsertPricingRangeRuleDto,
    @Req() req: Request,
  ) {
    return this.pricingRangesService.upsertRule(
      rangeId,
      dto,
      req.user as AuthUser,
    );
  }

  @Delete(":rangeId/rules/:idCrystal")
  @Roles("admin")
  removeRule(
    @Param("rangeId", ParseIntPipe) rangeId: number,
    @Param("idCrystal", ParseIntPipe) idCrystal: number,
    @Req() req: Request,
  ) {
    return this.pricingRangesService.removeRule(
      rangeId,
      idCrystal,
      req.user as AuthUser,
    );
  }
}
