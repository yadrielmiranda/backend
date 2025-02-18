import { Injectable } from '@nestjs/common';
import { CreateCoatingDto } from './dto/create-coating.dto';
import { UpdateCoatingDto } from './dto/update-coating.dto';

@Injectable()
export class CoatingService {
  create(createCoatingDto: CreateCoatingDto) {
    return 'This action adds a new coating';
  }

  findAll() {
    return `This action returns all coating`;
  }

  findOne(id: number) {
    return `This action returns a #${id} coating`;
  }

  update(id: number, updateCoatingDto: UpdateCoatingDto) {
    return `This action updates a #${id} coating`;
  }

  remove(id: number) {
    return `This action removes a #${id} coating`;
  }
}
