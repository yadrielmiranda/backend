import { Injectable } from '@nestjs/common';
import { CreateConfigDto } from './dto/create-config-.dto';
import { UpdateConfigDto } from './dto/update-config-.dto';

@Injectable()
export class ConfigSService {
  create(createConfigDto: CreateConfigDto) {
    return 'This action adds a new config';
  }

  findAll() {
    return `This action returns all configS`;
  }

  findOne(id: number) {
    return `This action returns a #${id} config`;
  }

  update(id: number, updateConfigDto: UpdateConfigDto) {
    return `This action updates a #${id} config`;
  }

  remove(id: number) {
    return `This action removes a #${id} config`;
  }
}
