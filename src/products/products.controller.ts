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
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Product as ProductModel } from '@prisma/client';
import { Roles } from 'src/auth/roles.decorator';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  // ✅ READ: todos los usuarios autenticados
  @Get()
  async getAllProducts(
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ): Promise<ProductModel[]> {
    return this.productsService.products({
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  // ✅ READ: todos los usuarios autenticados
  @Get('with-brands')
  findAllWithBrands(
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.productsService.findAllWithBrands({
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  // ✅ READ: todos los usuarios autenticados
  @Get(':id')
  async getProductById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ProductModel> {
    return this.productsService.product({ id });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Post()
  async createProduct(@Body() productData: CreateProductDto): Promise<ProductModel> {
    return this.productsService.createProduct(productData);
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Patch(':id')
  async updateProduct(
    @Param('id', ParseIntPipe) id: number,
    @Body() productData: UpdateProductDto,
  ): Promise<ProductModel> {
    return this.productsService.updateProduct({
      where: { id },
      data: productData,
    });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Delete(':id')
  async deleteProduct(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ProductModel> {
    return this.productsService.deleteProduct({ id });
  }
}
