import { IntersectionType, OmitType, PartialType, PickType } from '@nestjs/mapped-types';
import { IsNumber, Min, Max, MinLength, MaxLength, IsString, IsOptional, IsInt, IsIn, IsBoolean, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { CreateUserDto } from '@/users/dto/create-user.dto';
import { RegistrationConsentsDto } from '@/auth/dto/register-user.dto';
import { trimOrNull } from '@/common/transforms';

export class UpdateDealerInviteDto {
  // Keep the submitted decimal text, including the precision of a role markup.
  @Transform(({ obj, key }) => {
    const value: unknown = obj[key];
    return typeof value === 'number' || typeof value === 'string' ? String(value).trim() : value;
  })
  @IsString()
  @Matches(/^-?\d{1,8}(?:\.\d{1,16})?$/, { message: 'Enter a valid material markup percentage.' })
  markupPercent: string;
}

export class SubmitDealerRegistrationDto extends IntersectionType(PickType(CreateUserDto, [
  'firstName', 'lastName', 'email', 'phone', 'password',
  'street', 'addressLine2', 'city', 'state', 'postalCode',
] as const), PartialType(PickType(CreateUserDto, ['username'] as const), { skipNullProperties: false }), RegistrationConsentsDto) {
  @MinLength(8)
  declare password: string;

  @Transform(({ obj, key }) => trimOrNull({ value: obj[key] }))
  @IsOptional()
  @IsString()
  @MaxLength(150)
  companyName?: string;

  @Transform(({ obj, key }) => {
    const value: unknown = obj[key];
    return typeof value === 'string' && !value.trim() ? undefined : value;
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999999999999.99)
  estimatedMonthlySales?: number;

  // Implicit conversion would otherwise turn an empty HTML field or false into zero.
  @Transform(({ obj, key }) => obj[key])
  @IsInt()
  @Min(0)
  @Max(2147483647)
  yearsOfExperience: number;
}

export class ReviewDealerRegistrationDto {
  @Transform(({ obj, key }) => obj[key])
  @IsBoolean()
  approve: boolean;
}

export class CreateNetworkMemberDto extends OmitType(CreateUserDto, [
  'idRole', 'dealerMode', 'dealerEarningsPlanId',
  'isTaxExempt', 'installationPriceProfileId', 'paymentPlanId', 'noInstallationDeposit',
] as const) {
  @MinLength(8)
  declare password: string;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1000)
  markupPercent: number;

  // La API admite omisión para conservar clientes anteriores; 0 es una tasa explícita.
  @IsOptional()
  @Transform(({ obj, key }) => obj[key])
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  taxPercent?: number;

  // Solo administración puede elegir un superior diferente del usuario autenticado.
  @IsOptional()
  @IsInt()
  @Min(1)
  parentDealerId?: number;

  @IsOptional()
  @IsIn(['INTERNAL', 'EXTERNAL'])
  dealerMode?: 'INTERNAL' | 'EXTERNAL';

  @IsOptional()
  @IsIn(['AVAILABLE_PROFIT', 'MARKUP'])
  subdealerEarningsMode?: 'AVAILABLE_PROFIT' | 'MARKUP';

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  subdealerEarningsPercent?: number;
}

export class UpdateNetworkMarkupDto {
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1000)
  markupPercent: number;

  @IsOptional()
  @Transform(({ obj, key }) => obj[key])
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  taxPercent?: number;

  @IsOptional()
  @IsIn(['INTERNAL', 'EXTERNAL'])
  dealerMode?: 'INTERNAL' | 'EXTERNAL';

  @IsOptional()
  @IsIn(['AVAILABLE_PROFIT', 'MARKUP'])
  subdealerEarningsMode?: 'AVAILABLE_PROFIT' | 'MARKUP';

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  subdealerEarningsPercent?: number;
}

export class SetNetworkSuspensionDto {
  // Evita que la conversión implícita interprete la cadena "false" como true.
  @Transform(({ obj, key }) => obj[key])
  @IsBoolean()
  suspended: boolean;

  @Transform(({ obj, key }) => typeof obj[key] === 'string' ? obj[key].trim() : obj[key])
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class ReviewNetworkSuspensionDto {
  @Transform(({ obj, key }) => obj[key])
  @IsBoolean()
  approve: boolean;

  @IsOptional()
  @Transform(({ obj, key }) => typeof obj[key] === 'string' ? obj[key].trim() : obj[key])
  @IsString()
  @MaxLength(500)
  reason?: string;
}
