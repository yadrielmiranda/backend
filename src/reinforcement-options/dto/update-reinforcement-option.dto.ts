import { PartialType } from '@nestjs/mapped-types';
import { CreateReinforcementOptionDto } from './create-reinforcement-option.dto';

export class UpdateReinforcementOptionDto extends PartialType(
  CreateReinforcementOptionDto,
) {}