import { Injectable } from '@nestjs/common';
import { CreateSystemConfigDto } from './dto/create-system-config.dto';
import { UpdateSystemConfigDto } from './dto/update-system-config.dto';

@Injectable()
export class SystemConfigService {
  create(createSystemConfigDto: CreateSystemConfigDto) {
    return 'This action adds a new systemConfig';
  }

  findAll() {
    return `This action returns all systemConfig`;
  }

  findOne(id: number) {
    return `This action returns a #${id} systemConfig`;
  }

  update(id: number, updateSystemConfigDto: UpdateSystemConfigDto) {
    return `This action updates a #${id} systemConfig`;
  }

  remove(id: number) {
    return `This action removes a #${id} systemConfig`;
  }
}
