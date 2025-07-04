import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateEstimateDto } from './create-estimate.dto';

// 1. Omitimos tanto 'idUser' como 'pieces' del DTO base.
class CreateEstimateDataDto extends OmitType(CreateEstimateDto, [
  'idUser', 
  'pieces'
] as const) {}

// 2. UpdateEstimateDto hereda del resultado, sin las propiedades problemáticas.
export class UpdateEstimateDto extends PartialType(CreateEstimateDataDto) {}