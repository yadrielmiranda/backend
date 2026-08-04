import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

export class CreateOrderExtraChargeLineDto {
  @IsString()
  @MaxLength(500)
  description: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.0001)
  quantity: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  unitPrice: number;

  @IsOptional()
  @IsBoolean()
  taxable?: boolean;
}

export class CreateOrderExtraChargeDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderExtraChargeLineDto)
  lines: CreateOrderExtraChargeLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export enum OrderExtraChargeDecision {
  APPROVE = "APPROVE",
  REJECT = "REJECT",
}

export class RespondOrderExtraChargeDto {
  @IsEnum(OrderExtraChargeDecision)
  decision: OrderExtraChargeDecision;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
