import { IsOptional, IsString, IsNotEmpty, IsNumberString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateGlobalParameterDto {
  @ApiProperty({
    description: 'The new numeric value for the parameter.',
    example: '0.075',
  })
  @IsNumberString() 
  @IsNotEmpty()
  value: string;

  @ApiPropertyOptional({
    description: 'An optional description of what this parameter is for.',
    example: 'Florida state sales tax + county surtax.',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'The unit of the parameter, e.g., "%" or "USD".',
    example: '%',
  })
  @IsString()
  @IsOptional()
  unit?: string;
}
