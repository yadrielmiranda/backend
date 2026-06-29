// src/linear-pricing-rules/dto/create-linear-pricing-rule.dto.ts

import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsNumber, IsOptional, Min } from "class-validator";

export class CreateLinearPricingRuleDto {
    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    idBrand: number;

    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    idProduct: number;

    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    idSystem: number;

    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    idConfig: number;

    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 8 })
    @Min(0)
    @IsNotEmpty()
    costPerInch: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 3 })
    @Min(0)
    minLengthIn?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 3 })
    @Min(0)
    maxLengthIn?: number;
}