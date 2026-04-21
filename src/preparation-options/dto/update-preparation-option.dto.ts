import { PartialType } from '@nestjs/mapped-types';
import { CreatePreparationOptionDto } from './create-preparation-option.dto';

export class UpdatePreparationOptionDto extends PartialType(
  CreatePreparationOptionDto,
) {}