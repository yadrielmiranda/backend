import { IsInt, IsString, IsOptional, Matches, Min, ValidateIf } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { normalizeRoleMarkup, ROLE_MARKUP_MESSAGE, ROLE_MARKUP_PATTERN } from '../role-markup';

export class UpdateRoleDto {
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => normalizeRoleMarkup(value))
  @IsString()
  @Matches(ROLE_MARKUP_PATTERN, { message: ROLE_MARKUP_MESSAGE })
  markup?: string | number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  installationPriceProfileId?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  paymentPlanId?: number | null;
}
