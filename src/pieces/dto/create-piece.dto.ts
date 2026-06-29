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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  panelCode?: string | null;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  panelLabel: string;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  sashHeight?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  doorWidth?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  doorHeight?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  leftSideliteWidth?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  rightSideliteWidth?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  leftPanels?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  rightPanels?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  panelCount?: number | null;

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsNumber({}, { each: true })
  horizontalHeights?: number[] | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idCryst?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idTint?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  privacy?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idCoat?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  screen?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  highBottom?: boolean;

  @ApiProperty()
  @IsInt()
  @Min(1)
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