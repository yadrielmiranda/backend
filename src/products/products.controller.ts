import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Product as ProductModel } from '@prisma/client';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
   async createProduct(@Body() userData: CreateProductDto): Promise<ProductModel> {
     return this.productsService.createProduct(userData); 
   }

    @Get()
     async getAllUsers(): Promise<ProductModel[]> {
       return this.productsService.products({});
     }

     
     
}
