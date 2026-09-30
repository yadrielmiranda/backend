import { OmitType } from '@nestjs/mapped-types';
import { IsNumber, Min, Max, MinLength, MaxLength, IsString, IsOptional, IsInt, IsIn, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';
import { CreateUserDto } from '@/users/dto/create-user.dto';

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
