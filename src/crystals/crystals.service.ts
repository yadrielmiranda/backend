import { Injectable } from '@nestjs/common';
import { CreateCrystalDto } from './dto/create-crystal.dto';
import { UpdateCrystalDto } from './dto/update-crystal.dto';

@Injectable()
export class CrystalsService {
  create(createCrystalDto: CreateCrystalDto) {
    return 'This action adds a new crystal';
  }

  findAll() {
    return `This action returns all crystals`;
  }

  findOne(id: number) {
    return `This action returns a #${id} crystal`;
  }

  update(id: number, updateCrystalDto: UpdateCrystalDto) {
    return `This action updates a #${id} crystal`;
  }

  remove(id: number) {
    return `This action removes a #${id} crystal`;
  }
}
