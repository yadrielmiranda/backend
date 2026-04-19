import { PartialType } from '@nestjs/mapped-types';
import { CreateMuntinTypeDto } from './create-muntin-type.dto';

export class UpdateMuntinTypeDto extends PartialType(CreateMuntinTypeDto) {}