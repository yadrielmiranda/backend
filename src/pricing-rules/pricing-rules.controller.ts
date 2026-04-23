import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { PricingRulesService } from './pricing-rules.service';
import { CreatePricingRuleDto } from './dto/create-pricing-rule.dto';
import { UpdatePricingRuleDto } from './dto/update-pricing-rule.dto';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';

@Controller('pricing-rules')
export class PricingRulesController {
  constructor(private readonly pricingRulesService: PricingRulesService) {}

  @Post()
  @Roles('admin')
  create(@Body() createPricingRuleDto: CreatePricingRuleDto, @Req() req: Request) {
    return this.pricingRulesService.create(createPricingRuleDto, req.user as AuthUser);
  }

  @Get()
  @Roles('admin', 'operator')
  findAll() {
    return this.pricingRulesService.findAll();
  }

  @Get(':id')
  @Roles('admin', 'operator')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.pricingRulesService.findOne(id);
  }

  @Patch(':id')
  @Roles('admin')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updatePricingRuleDto: UpdatePricingRuleDto,
    @Req() req: Request,
  ) {
    return this.pricingRulesService.update(id, updatePricingRuleDto, req.user as AuthUser);
  }

  @Delete(':id')
  @Roles('admin')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.pricingRulesService.remove(id, req.user as AuthUser);
  }
}
