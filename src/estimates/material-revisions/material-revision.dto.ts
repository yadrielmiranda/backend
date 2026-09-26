import { Type, Transform } from 'class-transformer';
import { IsBoolean, IsDefined, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { CreatePieceDto } from '@/pieces/dto/create-piece.dto';

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
