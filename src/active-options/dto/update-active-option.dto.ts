import { PartialType } from '@nestjs/mapped-types';
import { CreateActiveOptionDto } from './create-active-option.dto';

export class UpdateActiveOptionDto extends PartialType(CreateActiveOptionDto) {}