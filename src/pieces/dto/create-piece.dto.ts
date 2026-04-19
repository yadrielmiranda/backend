import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsString,
  IsOptional,
  IsInt,
  IsNumberString,
  IsArray,
  ValidateNested,
  Min,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";

export class CreatePieceMuntinPanelDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  panelIndex: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  panelCode: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  horizontalLites: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  verticalLites: number;
}

export class CreatePieceMuntinDto {
  @ApiProperty()
  @IsInt()
  @IsNotEmpty()
  idPattern: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idType?: number | null;

  @ApiProperty({ type: () => [CreatePieceMuntinPanelDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePieceMuntinPanelDto)
  panels: CreatePieceMuntinPanelDto[];
}

export class CreatePieceDto {
  @ApiProperty()
  @IsString()
  mark: string;

  @ApiProperty()
  @IsInt()
  @IsNotEmpty()
  idProd: number;

  @ApiProperty()
  @IsInt()
  @IsNotEmpty()
  idBrand: number;

  @ApiProperty()
  @IsInt()
  @IsNotEmpty()
  idSyst: number;

  @ApiProperty()
  @IsInt()
  @IsNotEmpty()
  idConf: number;

  @ApiProperty()
  @IsInt()
  @IsNotEmpty()
  idFC: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  width?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  height?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  heightLeft?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  heightRight?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  legHeight?: string;

  @ApiProperty()
  @IsInt()
  @IsNotEmpty()
  idCryst: number;

  @ApiProperty()
  @IsInt()
  @IsNotEmpty()
  idTint: number;

  @ApiProperty()
  @IsBoolean()
  privacy: boolean;

  @ApiProperty()
  @IsInt()
  @IsNotEmpty()
  idCoat: number;

  @ApiProperty()
  @IsBoolean()
  screen: boolean;

  @ApiProperty()
  @IsInt()
  @IsNotEmpty()
  qty: number;

  @ApiPropertyOptional({ type: () => CreatePieceMuntinDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreatePieceMuntinDto)
  muntin?: CreatePieceMuntinDto | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  dealerMarkup?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idActiveOption?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idPreparationOption?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idSillOption?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idReinforcementOption?: number | null;
}