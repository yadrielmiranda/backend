import { Injectable } from '@nestjs/common';
import { CreateTintDto } from './dto/create-tint.dto';
import { UpdateTintDto } from './dto/update-tint.dto';

@Injectable()
export class TintsService {
  create(createTintDto: CreateTintDto) {
    return 'This action adds a new tint';
  }

  findAll() {
    return `This action returns all tints`;
  }

  findOne(id: number) {
    return `This action returns a #${id} tint`;
  }

  update(id: number, updateTintDto: UpdateTintDto) {
    return `This action updates a #${id} tint`;
  }

  remove(id: number) {
    return `This action removes a #${id} tint`;
  }
}
