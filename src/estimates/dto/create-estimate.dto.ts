// @/estimates/dto/create-estimate.dto.ts
import {
  IsNotEmpty,
  IsString,
  IsArray,
  ValidateNested,
  IsOptional,
  IsNumber,
  IsEmail,
  MaxLength,
  IsIn,
  Matches,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { CreatePieceDto } from "@/pieces/dto/create-piece.dto";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { US_STATE_CODES } from "@/common/us-states";
import { normalizeEmailOrNull, normalizeStateCodeOrNull, normalizeUSPhoneE164OrNull, normalizeZip5OrNull, trimOnly, trimOrNull } from "@/common/transforms";



export class CreateEstimateDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  @Transform(trimOnly)
  name: string;

  // -------------------------
  // Customer fields (optional)
  // -------------------------
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trimOrNull)
  customerFirstName?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trimOrNull)
  customerLastName?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(normalizeEmailOrNull)
  @IsEmail()
  @MaxLength(150)
  customerEmail?: string | null;


  @ApiPropertyOptional()
  @IsOptional()
  @Transform(normalizeUSPhoneE164OrNull)
  @MaxLength(30)
  @Matches(/^\+1\d{10}$/, { message: "customerPhone must be E.164 US format like +13055551234" })
  customerPhone?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  @Transform(trimOrNull)
  customerStreet?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trimOrNull)
  customerCity?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Transform(normalizeStateCodeOrNull)
  @IsIn(US_STATE_CODES, { message: "customerState must be a valid US state code (e.g. FL)." })
  customerState?: string | null;


  @ApiPropertyOptional()
  @IsOptional()
  @Transform(normalizeZip5OrNull)
  @MaxLength(20)
  @Matches(/^\d{5}$/, { message: "customerPostalCode must be a valid ZIP (5 digits)" })
  customerPostalCode?: string | null;

  // impuesto que el dealer cobra al cliente (ej. 0.07 = 7%)
  @ApiPropertyOptional({
    description: "Customer tax rate (e.g. 0.07 for 7%)",
    example: 0.07,
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  customerTaxRate?: number;

  @ApiProperty({ type: () => [CreatePieceDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePieceDto)
  pieces: CreatePieceDto[];
}
