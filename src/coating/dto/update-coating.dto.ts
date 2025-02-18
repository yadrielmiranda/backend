import { PartialType } from '@nestjs/mapped-types';
import { CreateCoatingDto } from './create-coating.dto';

export class UpdateCoatingDto extends PartialType(CreateCoatingDto) {}
