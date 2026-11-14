import { Type, Transform } from 'class-transformer';
import { IsBoolean, IsDefined, IsEmail, IsIn, IsInt, IsNotEmpty, IsOptional, IsPhoneNumber, IsString, Matches, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { CreatePieceDto } from '@/pieces/dto/create-piece.dto';
import { US_STATE_CODES } from '@/common/us-states';
import { transformAddressLine2 } from '@/common/address-line2';
import { PHONE_VALIDATION_MESSAGE, transformPhone } from '@/common/phone';
import { normalizeEmailOrNull, normalizeStateCodeOrNull, normalizeZip5OrNull, trimOnly, trimOrNull } from '@/common/transforms';

export class MaterialRevisionCustomerDto {
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimOnly) @IsString() @IsNotEmpty() @MaxLength(255)
  name?: string;

  @IsOptional() @Transform(trimOrNull) @IsString() @MaxLength(100)
  firstName?: string | null;
  @IsOptional() @Transform(trimOrNull) @IsString() @MaxLength(100)
  lastName?: string | null;
  @IsOptional() @Transform(normalizeEmailOrNull) @IsEmail() @MaxLength(150)
  email?: string | null;
  @IsOptional() @Transform(transformPhone) @IsString() @MaxLength(30)
  @Matches(/^\+[1-9]\d{1,14}$/, { message: PHONE_VALIDATION_MESSAGE })
  @IsPhoneNumber(undefined, { message: PHONE_VALIDATION_MESSAGE })
  phone?: string | null;
  @IsOptional() @Transform(trimOrNull) @IsString() @MaxLength(150)
  street?: string | null;
  @IsOptional() @Transform(transformAddressLine2) @IsString() @MaxLength(150)
  addressLine2?: string | null;
  @IsOptional() @Transform(trimOrNull) @IsString() @MaxLength(100)
  city?: string | null;
  @IsOptional() @Transform(normalizeStateCodeOrNull) @IsString() @IsIn(US_STATE_CODES)
  state?: string | null;
  @IsOptional() @Transform(args => normalizeZip5OrNull(args) ?? trimOrNull(args)) @Matches(/^\d{5}$/) @MaxLength(20)
  postalCode?: string | null;
}

export class RemoveMaterialRevisionPieceDto {
  @IsInt() @Min(1)
  originalPieceId: number;
}

export class BeginMaterialRevisionDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @IsNotEmpty() @MaxLength(1000)
  reason: string;

  @IsOptional() @IsBoolean()
  factoryNotSentConfirmed?: boolean;
}
export class MaterialRevisionPieceDto {
  @IsOptional() @IsInt() @Min(1)
  originalPieceId?: number;

  @IsOptional() @IsString() @MaxLength(36)
  itemKey?: string;

  @IsDefined() @ValidateNested() @Type(() => CreatePieceDto)
  piece: CreatePieceDto;
}
export class MaterialRevisionDecisionDto {
  @IsIn(['APPROVE', 'REJECT', 'CANCEL'])
  decision: 'APPROVE' | 'REJECT' | 'CANCEL';

  @IsOptional() @IsBoolean()
  accepted?: boolean;
}
export class SubmitMaterialRevisionDto {
  @IsBoolean()
  accepted: boolean;
}
