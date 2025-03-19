import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { BrandsService } from './brands.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { Brand as BrandModel} from '@prisma/client';

@Controller('brands')
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  @Post()
  async createBrand(
    @Body() brandData: CreateBrandDto,
  ): Promise<BrandModel> {
    return this.brandsService.createBrand(brandData);
  }

  //@UseGuards(AuthGuard)
  @Get()
  async getAllBrands(): Promise<BrandModel[]> {
    return this.brandsService.brands({}); 
  }

  @Get(':id')
  async getBrand(@Param('id') id: string): Promise<BrandModel> {
    return this.brandsService.brand({ id: Number(id) });
  }

  @Patch(':id')
  async updateBrand(
    @Param('id') id: string,
    @Body() brandData: UpdateBrandDto,
  ): Promise<BrandModel> {
    return this.brandsService.updateBrand({
      where: { id: Number(id) },
      data: brandData,
    });
  }

  @Delete(':id')
  async deleteBrand(@Param('id') id: string): Promise<BrandModel> {
    return this.brandsService.deleteBrand({ id: Number(id) });
  }
}
