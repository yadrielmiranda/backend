// src/linear-pricing-rules/linear-pricing-rules.controller.ts

import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    ParseIntPipe,
    Patch,
    Post,
    Query,
} from "@nestjs/common";
import { Roles } from "@/auth/roles.decorator";
import { LinearPricingRulesService } from "./linear-pricing-rules.service";
import { CreateLinearPricingRuleDto } from "./dto/create-linear-pricing-rule.dto";
import { UpdateLinearPricingRuleDto } from "./dto/update-linear-pricing-rule.dto";

@Controller("linear-pricing-rules")
export class LinearPricingRulesController {
    constructor(
        private readonly linearPricingRulesService: LinearPricingRulesService,
    ) { }

    @Get()
    findAll(
        @Query("take") take?: string,
        @Query("skip") skip?: string,
        @Query("brand") idBrand?: string,
        @Query("product") idProduct?: string,
        @Query("system") idSystem?: string,
        @Query("config") idConfig?: string,
    ) {
        return this.linearPricingRulesService.findAll({
            take: take ? Number(take) : undefined,
            skip: skip ? Number(skip) : undefined,
            idBrand: idBrand ? Number(idBrand) : undefined,
            idProduct: idProduct ? Number(idProduct) : undefined,
            idSystem: idSystem ? Number(idSystem) : undefined,
            idConfig: idConfig ? Number(idConfig) : undefined,
        });
    }

    @Get(":id")
    findOne(@Param("id", ParseIntPipe) id: number) {
        return this.linearPricingRulesService.findOne(id);
    }

    @Roles("admin")
    @Post()
    create(@Body() body: CreateLinearPricingRuleDto) {
        return this.linearPricingRulesService.create(body);
    }

    @Roles("admin")
    @Patch(":id")
    update(
        @Param("id", ParseIntPipe) id: number,
        @Body() body: UpdateLinearPricingRuleDto,
    ) {
        return this.linearPricingRulesService.update(id, body);
    }

    @Roles("admin")
    @Delete(":id")
    remove(@Param("id", ParseIntPipe) id: number) {
        return this.linearPricingRulesService.remove(id);
    }
}