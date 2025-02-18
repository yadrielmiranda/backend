import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { CrystalsService } from './crystals.service';
import { CreateCrystalDto } from './dto/create-crystal.dto';
import { UpdateCrystalDto } from './dto/update-crystal.dto';

@Controller('crystals')
export class CrystalsController {
  constructor(private readonly crystalsService: CrystalsService) {}

  @Post()
  create(@Body() createCrystalDto: CreateCrystalDto) {
    return this.crystalsService.create(createCrystalDto);
  }

  @Get()
  findAll() {
    return this.crystalsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.crystalsService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateCrystalDto: UpdateCrystalDto) {
    return this.crystalsService.update(+id, updateCrystalDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.crystalsService.remove(+id);
  }
}
