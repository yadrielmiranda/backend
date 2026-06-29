// src/products/dto/create-product.dto.ts

import { ProductKind, PricingMode } from "@prisma/client";
import { IsEnum, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class CreateProductDto {
    @IsNotEmpty()
    @IsString()
    name: string;

    @IsOptional()
    @IsEnum(ProductKind)
    kind?: ProductKind;

    @IsOptional()
    @IsEnum(PricingMode)
    pricingMode?: PricingMode;
}