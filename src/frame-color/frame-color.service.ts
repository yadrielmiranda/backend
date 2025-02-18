import { Injectable } from '@nestjs/common';
import { CreateFrameColorDto } from './dto/create-frame-color.dto';
import { UpdateFrameColorDto } from './dto/update-frame-color.dto';

@Injectable()
export class FrameColorService {
  create(createFrameColorDto: CreateFrameColorDto) {
    return 'This action adds a new frameColor';
  }

  findAll() {
    return `This action returns all frameColor`;
  }

  findOne(id: number) {
    return `This action returns a #${id} frameColor`;
  }

  update(id: number, updateFrameColorDto: UpdateFrameColorDto) {
    return `This action updates a #${id} frameColor`;
  }

  remove(id: number) {
    return `This action removes a #${id} frameColor`;
  }
}
