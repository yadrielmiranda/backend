// src/products/dto/create-product.dto.ts

import {
    DiagramFamily,
    PricingMode,
    ProductKind,
} from "@prisma/client";
import {
    IsEnum,
    IsNotEmpty,
    IsOptional,
    IsString,
} from "class-validator";

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

    @IsOptional()
    @IsEnum(DiagramFamily)
    diagramFamily?: DiagramFamily;
}