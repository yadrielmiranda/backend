import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import type { SignatureStrokes } from './contract-pdf.service';

export class PrepareAgreementDto {
  @IsIn(['detailed', 'total']) pricingMode: 'detailed' | 'total';
  @IsOptional() @IsBoolean() useLatestContract?: boolean;
}

export class SignAgreementDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/) contentHash: string;
  @IsString() @MaxLength(150) signerName: string;
  @IsBoolean() @Equals(true) accepted: boolean;
  @IsArray() @ArrayMaxSize(100) signature: SignatureStrokes;
}
