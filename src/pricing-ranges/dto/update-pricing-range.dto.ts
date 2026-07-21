import { OmitType, PartialType } from "@nestjs/mapped-types";

import { CreatePricingRangeDto } from "./create-pricing-range.dto";

export class UpdatePricingRangeDto extends PartialType(
  OmitType(CreatePricingRangeDto, ["idSystem", "idConfig"] as const),
) {}
