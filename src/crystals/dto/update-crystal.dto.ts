import { PartialType } from '@nestjs/mapped-types';
import { CreateCrystalDto } from './create-crystal.dto';

export class UpdateCrystalDto extends PartialType(CreateCrystalDto) {}
