// src/linear-pricing-rules/dto/update-linear-pricing-rule.dto.ts

import { PartialType } from "@nestjs/mapped-types";
import { CreateLinearPricingRuleDto } from "./create-linear-pricing-rule.dto";

export class UpdateLinearPricingRuleDto extends PartialType(
    CreateLinearPricingRuleDto,
) { }