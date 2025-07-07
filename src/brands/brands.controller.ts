import { Controller, Get, Post, Body, Patch, Param, Delete, ParseIntPipe } from '@nestjs/common';
import { BrandsService } from './brands.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { Brand as BrandModel } from '@prisma/client';

@Controller('brands')
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) { }

  @Post()
  async createBrand(@Body() brandData: CreateBrandDto): Promise<BrandModel> {
    return this.brandsService.createBrand(brandData);
  }

  @Get()
  async getAllBrands(): Promise<BrandModel[]> {
    return this.brandsService.brands({});
  }

  /**
   * ✅ RUTA CORREGIDA
   * Se ha movido esta ruta específica ANTES de la ruta con parámetro ':id'
   * para evitar conflictos.
   */
  @Get('with-products')
  findAllWithProducts() {
    return this.brandsService.findAllWithProducts();
  }

  /**
   * Esta ruta con parámetro ahora está después de las rutas específicas.
   */
  @Get(':id')
  async getBrandById(@Param('id', ParseIntPipe) id: number): Promise<BrandModel> {
    return this.brandsService.brand({ id });
  }

  @Patch(':id')
  async updateBrand(
    @Param('id', ParseIntPipe) id: number,
    @Body() brandData: UpdateBrandDto,
  ): Promise<BrandModel> {
    return this.brandsService.updateBrand({ where: { id }, data: brandData });
  }

  @Delete(':id')
  async deleteBrand(@Param('id', ParseIntPipe) id: number): Promise<BrandModel> {
    return this.brandsService.deleteBrand({ id });
  }

  @Get(':id/products')
  async getBrandProducts(@Param('id', ParseIntPipe) id: number): Promise<BrandModel> {
    return this.brandsService.getBrandWithProducts({ id });
  }

  @Post(':brandId/products/:productId')
  async addProductToBrand(
    @Param('brandId', ParseIntPipe) brandId: number,
    @Param('productId', ParseIntPipe) productId: number,
  ): Promise<BrandModel> {
    return this.brandsService.addProductToBrand(brandId, productId);
  }

  @Delete(':brandId/products/:productId')
  async removeProductFromBrand(
    @Param('brandId', ParseIntPipe) brandId: number,
    @Param('productId', ParseIntPipe) productId: number,
  ): Promise<BrandModel> {
    return this.brandsService.removeProductFromBrand(brandId, productId);
  }
}
