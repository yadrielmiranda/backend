import { Type } from 'class-transformer';
import {
    IsArray,
    IsDefined,
    IsEnum,
    IsInt,
    IsOptional,
    Min,
    ValidateNested,
} from 'class-validator';
import { PricingComponentType } from '@prisma/client';

export class SystemConfigPricingComponentDto {
    @IsEnum(PricingComponentType)
    componentType: PricingComponentType;

    @Type(() => Number)
    @IsInt()
    @Min(1)
    sourceConfigId: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    quantity?: number | null;
}

export class UpdateSystemConfigPricingComponentsDto {
    @IsDefined()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SystemConfigPricingComponentDto)
    components: SystemConfigPricingComponentDto[];
}