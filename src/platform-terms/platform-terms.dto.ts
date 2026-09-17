import { Type } from 'class-transformer';
import { Equals, IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { TERMS_CONTENT_LIMIT } from './platform-terms-content';

export class AcceptPlatformTermsDto {
  @Equals(true)
  accepted: unknown;

  @IsInt()
  @Min(1)
  versionId: number;
}

export class PublishPlatformTermsTextDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  currentVersionId: number;

  @IsString()
  @MinLength(1)
  @MaxLength(TERMS_CONTENT_LIMIT)
  content: unknown;
}
