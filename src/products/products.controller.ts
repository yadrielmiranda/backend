import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Product as ProductModel } from '@prisma/client';


@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) { }

  @Post()
  async createProduct(
    @Body() productData: CreateProductDto,
  ): Promise<ProductModel> {
    return this.productsService.createProduct(productData);
  }

  
  @Get()
  async getAllProducts(): Promise<ProductModel[]> {
    return this.productsService.products({});
  }

  /**
   * ✅ NUEVA RUTA AÑADIDA
   * Expone el método para obtener todos los productos con sus marcas.
   * Se coloca antes de la ruta ':id' para que NestJS la encuentre primero.
   */
  @Get('with-brands')
  findAllWithBrands() {
    return this.productsService.findAllWithBrands();
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
