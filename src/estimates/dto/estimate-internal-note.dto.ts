import { Transform } from 'class-transformer';
import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

export class UpdateEstimateInternalNoteDto {
  @Transform(({ obj }) => obj.text)
  @IsString()
  @MaxLength(2000)
  text!: string;

  @Transform(({ obj }) => obj.expectedVersion)
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedVersion!: number;
}
