import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
} from '@nestjs/common';
import { PricingRulesService } from './pricing-rules.service';
import { CreatePricingRuleDto } from './dto/create-pricing-rule.dto';
import { UpdatePricingRuleDto } from './dto/update-pricing-rule.dto';
import { Roles } from 'src/auth/roles.decorator';

@Controller('pricing-rules')
export class PricingRulesController {
  constructor(private readonly pricingRulesService: PricingRulesService) {}

  // 🔒 WRITE: solo admin
  @Post()
  @Roles('admin')
  create(@Body() createPricingRuleDto: CreatePricingRuleDto) {
    return this.pricingRulesService.create(createPricingRuleDto);
  }

  // ✅ READ: admin/operator
  @Get()
  @Roles('admin', 'operator')
  findAll() {
    return this.pricingRulesService.findAll();
  }

  // ✅ READ: admin/operator
  @Get(':id')
  @Roles('admin', 'operator')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.pricingRulesService.findOne(id);
  }

  // 🔒 WRITE: solo admin
  @Patch(':id')
  @Roles('admin')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updatePricingRuleDto: UpdatePricingRuleDto,
  ) {
    return this.pricingRulesService.update(id, updatePricingRuleDto);
  }

  // 🔒 WRITE: solo admin
  @Delete(':id')
  @Roles('admin')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.pricingRulesService.remove(id);
  }
}
