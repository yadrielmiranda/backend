import { PartialType } from '@nestjs/mapped-types';
import { CreateSillOptionDto } from './create-sill-option.dto';

export class UpdateSillOptionDto extends PartialType(CreateSillOptionDto) {}