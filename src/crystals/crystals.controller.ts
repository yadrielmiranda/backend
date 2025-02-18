import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { CrystalsService } from './crystals.service';
import { CreateCrystalDto } from './dto/create-crystal.dto';
import { UpdateCrystalDto } from './dto/update-crystal.dto';
import { Crystal as CrystalModel } from '@prisma/client';

@Controller('crystals')
export class CrystalsController {
  constructor(private readonly crystalsService: CrystalsService) { }

  @Post()
  async createCrystal(
    @Body() crystalData: CreateCrystalDto,
  ): Promise<CrystalModel> {
    return this.crystalsService.createCrystal(crystalData);
  }

  @Get()
  async getAllCrystals(): Promise<CrystalModel[]> {
    return this.crystalsService.crystals({});
  }

  @Get(':id')
  async getCrystal(@Param('id') id: string): Promise<CrystalModel> {
    return this.crystalsService.crystal({ id: Number(id) });
  }

  @Patch(':id')
  async updateCrystal(
    @Param('id') id: string,
    @Body() crystalData: UpdateCrystalDto,
  ): Promise<CrystalModel> {
    return this.crystalsService.updateCrystal({
      where: { id: Number(id) },
      data: crystalData,
    });
  }

  @Delete(':id')
  async deleteCrystal(@Param('id') id: string): Promise<CrystalModel> {
    return this.crystalsService.deleteCrystal({ id: Number(id) });
  }
}
