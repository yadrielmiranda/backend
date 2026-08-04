import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { InstallationJobStatus } from '@prisma/client';

export const INSTALLATION_LIST_SCOPES = [
  'active',
  'completed',
  'canceled',
  'all',
] as const;

export type InstallationListScope =
  (typeof INSTALLATION_LIST_SCOPES)[number];

export class FindInstallationJobsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([25, 50, 100])
  pageSize = 25;

  @IsOptional()
  @IsIn(INSTALLATION_LIST_SCOPES)
  scope: InstallationListScope = 'active';

  @IsOptional()
  @IsEnum(InstallationJobStatus)
  status?: InstallationJobStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
