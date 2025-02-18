import { PartialType } from '@nestjs/mapped-types';
import { CreateFrameColorDto } from './create-frame-color.dto';

export class UpdateFrameColorDto extends PartialType(CreateFrameColorDto) {}
