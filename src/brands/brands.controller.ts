import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { BrandsService } from './brands.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { Brand as BrandModel } from '@prisma/client';
import { Roles } from '@/auth/roles.decorator';

@Controller('brands')
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  // ✅ READ: todos los usuarios autenticados
  @Roles('admin', 'operator')
  @Get()
  async getAllBrands(
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ): Promise<BrandModel[]> {
    return this.brandsService.brands({
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  // ✅ READ: todos los usuarios autenticados
  
  @Get('with-products')
  findAllWithProducts(
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.brandsService.findAllWithProducts({
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  // ✅ READ: todos los usuarios autenticados
  
  @Get(':id')
  async getBrandById(@Param('id', ParseIntPipe) id: number): Promise<BrandModel> {
    return this.brandsService.brand({ id });
  }

  // ✅ READ: todos los usuarios autenticados
 
  @Get(':id/products')
  async getBrandProducts(@Param('id', ParseIntPipe) id: number): Promise<BrandModel> {
    return this.brandsService.getBrandWithProducts({ id });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Post()
  async createBrand(@Body() brandData: CreateBrandDto): Promise<BrandModel> {
    return this.brandsService.createBrand(brandData);
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Patch(':id')
  async updateBrand(
    @Param('id', ParseIntPipe) id: number,
    @Body() brandData: UpdateBrandDto,
  ): Promise<BrandModel> {
    return this.brandsService.updateBrand({ where: { id }, data: brandData });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Delete(':id')
  async deleteBrand(@Param('id', ParseIntPipe) id: number): Promise<BrandModel> {
    return this.brandsService.deleteBrand({ id });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Post(':brandId/products/:productId')
  async addProductToBrand(
    @Param('brandId', ParseIntPipe) brandId: number,
    @Param('productId', ParseIntPipe) productId: number,
  ): Promise<BrandModel> {
    return this.brandsService.addProductToBrand(brandId, productId);
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Delete(':brandId/products/:productId')
  async removeProductFromBrand(
    @Param('brandId', ParseIntPipe) brandId: number,
    @Param('productId', ParseIntPipe) productId: number,
  ): Promise<BrandModel> {
    return this.brandsService.removeProductFromBrand(brandId, productId);
  }
}
