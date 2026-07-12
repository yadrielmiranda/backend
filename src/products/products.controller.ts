// src/products/products.controller.ts

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { Product as ProductModel } from "@prisma/client";

import { Roles } from "@/auth/roles.decorator";

import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { ProductsService } from "./products.service";

@Controller("products")
export class ProductsController {
  constructor(private readonly productsService: ProductsService) { }

  @Get()
  async getAllProducts(
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ): Promise<ProductModel[]> {
    return this.productsService.products({
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Get("with-brands")
  findAllWithBrands(
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    return this.productsService.findAllWithBrands({
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Get(":id")
  async getProductById(
    @Param("id", ParseIntPipe) id: number,
  ): Promise<ProductModel> {
    return this.productsService.product({ id });
  }

  @Roles("admin")
  @Post()
  async createProduct(
    @Body() productData: CreateProductDto,
  ): Promise<ProductModel> {
    return this.productsService.createProduct(productData);
  }

  @Roles("admin")
  @Patch(":id")
  async updateProduct(
    @Param("id", ParseIntPipe) id: number,
    @Body() productData: UpdateProductDto,
  ): Promise<ProductModel> {
    return this.productsService.updateProduct({
      where: { id },
      data: productData,
    });
  }

  @Roles("admin")
  @Delete(":id")
  async deleteProduct(
    @Param("id", ParseIntPipe) id: number,
  ): Promise<ProductModel> {
    return this.productsService.deleteProduct({ id });
  }
}