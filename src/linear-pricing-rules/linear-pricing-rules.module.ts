// src/linear-pricing-rules/linear-pricing-rules.module.ts

import { Module } from "@nestjs/common";
import { PrismaModule } from "@/prisma/prisma.module";
import { LinearPricingRulesService } from "./linear-pricing-rules.service";
import { LinearPricingRulesController } from "./linear-pricing-rules.controller";

@Module({
    imports: [PrismaModule],
    controllers: [LinearPricingRulesController],
    providers: [LinearPricingRulesService],
    exports: [LinearPricingRulesService],
})
export class LinearPricingRulesModule { }