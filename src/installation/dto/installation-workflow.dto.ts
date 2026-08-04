import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  EstimateRevisionChangeReason,
  EstimateRevisionItemAction,
  InstallationApprovalDecision,
  InstallationAppointmentType,
  InstallationLineOrigin,
  InstallationPermitStatus,
} from '@prisma/client';
import { CreatePieceDto } from '@/pieces/dto/create-piece.dto';

export class AddInstallationLineDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  serviceId: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  widthIn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  heightIn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.0001)
  areaSqFt?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  panelCount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  lengthIn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  occurrences?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsEnum(InstallationLineOrigin)
  origin?: InstallationLineOrigin;
}

export class RequestInstallationDto {
  @IsOptional()
  @IsBoolean()
  permitRequested?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AddInstallationLineDto)
  selectedServices?: AddInstallationLineDto[];
}

export class AddInstallationMeasurementDto {
  @IsString()
  @MaxLength(150)
  label: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  unitIndex?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  widthIn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  heightIn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  heightLeftIn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  heightRightIn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  legHeightIn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  sashHeightIn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  windowHeightIn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  doorWidthIn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  doorHeightIn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  leftSideliteWidthIn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  rightSideliteWidthIn?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  leftPanels?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  rightPanels?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  panelCount?: number;

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsNumber({}, { each: true })
  @Min(0.001, { each: true })
  horizontalHeights?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  lengthIn?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateInstallationMeasurementDto extends PartialType(
  AddInstallationMeasurementDto,
) {}

export class ProposeInstallationMeasurementPieceDto {
  @IsEnum(EstimateRevisionItemAction)
  action: EstimateRevisionItemAction;

  @IsEnum(EstimateRevisionChangeReason)
  reason: EstimateRevisionChangeReason;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreatePieceDto)
  piece?: CreatePieceDto;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class SubmitInstallationQuoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class InstallationApprovalDto {
  @IsEnum(InstallationApprovalDecision)
  decision: InstallationApprovalDecision;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

export class UpdateInstallationPermitDto {
  @IsEnum(InstallationPermitStatus)
  status: InstallationPermitStatus;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cityFee?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class ProposeInstallationAppointmentDto {
  @IsEnum(InstallationAppointmentType)
  type: InstallationAppointmentType;

  @IsDateString()
  startsAt: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export enum InstallationAppointmentResponse {
  ACCEPT = 'ACCEPT',
  REQUEST_RESCHEDULE = 'REQUEST_RESCHEDULE',
}

export class RespondInstallationAppointmentDto {
  @IsEnum(InstallationAppointmentResponse)
  response: InstallationAppointmentResponse;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class CancelInstallationDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
