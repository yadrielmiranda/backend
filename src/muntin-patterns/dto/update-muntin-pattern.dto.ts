import { PartialType } from '@nestjs/mapped-types';
import { CreateMuntinPatternDto } from './create-muntin-pattern.dto';

export class UpdateMuntinPatternDto extends PartialType(CreateMuntinPatternDto) {}