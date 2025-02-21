import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, } from '@nestjs/common';
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

  @UseGuards(AuthGuard)
  @Get()
  async getAllProducts(): Promise<ProductModel[]> {
    return this.productsService.products({});
  }

  @Get(':id')
  async getProduct(@Param('id') id: string): Promise<ProductModel> {
    return this.productsService.product({ id: Number(id) });
  }

  @Patch(':id')
  async updateProduct(
    @Param('id') id: string,
    @Body() productData: UpdateProductDto,
  ): Promise<ProductModel> {
    return this.productsService.updateProduct({
      where: { id: Number(id) },
      data: productData,
    });
  }

  @Delete(':id')
  async deleteUser(@Param('id') id: string): Promise<ProductModel> {
    return this.productsService.deleteProduct({ id: Number(id) });
  }
  
}
