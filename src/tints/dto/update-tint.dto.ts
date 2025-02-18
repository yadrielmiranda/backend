import { PartialType } from '@nestjs/mapped-types';
import { CreateTintDto } from './create-tint.dto';

export class UpdateTintDto extends PartialType(CreateTintDto) {}
