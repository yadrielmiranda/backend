import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Product as ProductModel } from '@prisma/client';
import { AuthGuard } from 'src/auth/guards/auth/auth.guard';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) { }

  @Post()
  async createProduct(
    @Body() productData: CreateProductDto,
  ): Promise<ProductModel> {
    return this.productsService.createProduct(productData);
  }

  //@UseGuards(AuthGuard)
  @Get()
  async getAllProducts(): Promise<ProductModel[]> {
    return this.productsService.products({});
  }

  @Get(':id')
  async getProductById(@Param('id', ParseIntPipe) id: number): Promise<ProductModel> {
    return this.productsService.product({ id });
  }

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

  @Delete(':id')
  async deleteProduct(@Param('id', ParseIntPipe) id: number): Promise<ProductModel> {
    return this.productsService.deleteProduct({ id });
  }
}
