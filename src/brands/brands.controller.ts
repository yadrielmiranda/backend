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
} from "@nestjs/common";
import { BrandsService } from "./brands.service";
import { CreateBrandDto } from "./dto/create-brand.dto";
import { UpdateBrandDto } from "./dto/update-brand.dto";
import { UpdateBrandCoatingsDto } from "./dto/update-brand-coatings.dto";
import { UpdateBrandPrivaciesDto } from "./dto/update-brand-privacies.dto";
import { UpdateBrandTintsDto } from "./dto/update-brand-tints.dto";
import { Brand as BrandModel } from "@prisma/client";
import { Roles } from "@/auth/roles.decorator";

@Controller("brands")
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) { }

  @Roles("admin", "operator")
  @Get()
  async getAllBrands(
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ): Promise<BrandModel[]> {
    return this.brandsService.brands({
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Get("with-products")
  findAllWithProducts(
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    return this.brandsService.findAllWithProducts({
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Get(":id/available-products")
  async getAvailableProductsForBrand(@Param("id", ParseIntPipe) id: number) {
    return this.brandsService.getAvailableProductsForBrand(id);
  }

  @Roles("admin", "operator")
  @Get(":id/tints/manage")
  async getBrandTintsForManage(@Param("id", ParseIntPipe) id: number) {
    return this.brandsService.getBrandTintsForManage(id);
  }

  @Roles("admin")
  @Patch(":id/tints/manage")
  async updateBrandTints(
    @Param("id", ParseIntPipe) id: number,
    @Body() data: UpdateBrandTintsDto,
  ) {
    return this.brandsService.updateBrandTints(id, data);
  }

  @Roles("admin", "operator")
  @Get(":id/coatings/manage")
  async getBrandCoatingsForManage(@Param("id", ParseIntPipe) id: number) {
    return this.brandsService.getBrandCoatingsForManage(id);
  }

  @Roles("admin")
  @Patch(":id/coatings/manage")
  async updateBrandCoatings(
    @Param("id", ParseIntPipe) id: number,
    @Body() data: UpdateBrandCoatingsDto,
  ) {
    return this.brandsService.updateBrandCoatings(id, data);
  }

  @Roles("admin", "operator")
  @Get(":id/privacies/manage")
  async getBrandPrivaciesForManage(@Param("id", ParseIntPipe) id: number) {
    return this.brandsService.getBrandPrivaciesForManage(id);
  }

  @Roles("admin")
  @Patch(":id/privacies/manage")
  async updateBrandPrivacies(
    @Param("id", ParseIntPipe) id: number,
    @Body() data: UpdateBrandPrivaciesDto,
  ) {
    return this.brandsService.updateBrandPrivacies(id, data);
  }

  @Get(":id")
  async getBrandById(@Param("id", ParseIntPipe) id: number): Promise<BrandModel> {
    return this.brandsService.brand({ id });
  }

  @Get(":id/products")
  async getBrandProducts(@Param("id", ParseIntPipe) id: number): Promise<BrandModel> {
    return this.brandsService.getBrandWithProducts({ id });
  }

  @Roles("admin")
  @Post()
  async createBrand(@Body() brandData: CreateBrandDto): Promise<BrandModel> {
    return this.brandsService.createBrand(brandData);
  }

  @Roles("admin")
  @Patch(":id")
  async updateBrand(
    @Param("id", ParseIntPipe) id: number,
    @Body() brandData: UpdateBrandDto,
  ): Promise<BrandModel> {
    return this.brandsService.updateBrand({
      where: { id },
      data: brandData,
    });
  }

  @Roles("admin")
  @Delete(":id")
  async deleteBrand(@Param("id", ParseIntPipe) id: number): Promise<BrandModel> {
    return this.brandsService.deleteBrand({ id });
  }

  @Roles("admin")
  @Post(":brandId/products/:productId")
  async addProductToBrand(
    @Param("brandId", ParseIntPipe) brandId: number,
    @Param("productId", ParseIntPipe) productId: number,
  ): Promise<BrandModel> {
    return this.brandsService.addProductToBrand(brandId, productId);
  }

  @Roles("admin")
  @Delete(":brandId/products/:productId")
  async removeProductFromBrand(
    @Param("brandId", ParseIntPipe) brandId: number,
    @Param("productId", ParseIntPipe) productId: number,
  ): Promise<BrandModel> {
    return this.brandsService.removeProductFromBrand(brandId, productId);
  }
}
