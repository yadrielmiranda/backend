import { Type } from "class-transformer";
import { IsInt, Min } from "class-validator";

export class AvailablePricingRangeCrystalsQueryDto {
    @Type(() => Number)
    @IsInt()
    @Min(1)
    idSystem: number;

    @Type(() => Number)
    @IsInt()
    @Min(1)
    idConfig: number;
}