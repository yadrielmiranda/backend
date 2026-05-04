import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
} from "@nestjs/common";
import { CrystalService } from "./crystals.service";
import { CreateCrystalDto } from "./dto/create-crystal.dto";
import { UpdateCrystalDto } from "./dto/update-crystal.dto";
import { Crystal as CrystalModel } from "@prisma/client";
import { Roles } from "@/auth/roles.decorator";

@Controller("crystals")
export class CrystalController {
  constructor(private readonly crystalService: CrystalService) {}

  @Get()
  async getAllCrystals(): Promise<CrystalModel[]> {
    return this.crystalService.crystals({});
  }

  @Get(":id")
  async getCrystalById(
    @Param("id", ParseIntPipe) id: number,
  ): Promise<CrystalModel> {
    return this.crystalService.crystal({ id });
  }

  @Roles("admin")
  @Post()
  async createCrystal(
    @Body() crystalData: CreateCrystalDto,
  ): Promise<CrystalModel> {
    return this.crystalService.createCrystal(crystalData);
  }

  @Roles("admin")
  @Patch(":id")
  async updateCrystal(
    @Param("id", ParseIntPipe) id: number,
    @Body() crystalData: UpdateCrystalDto,
  ): Promise<CrystalModel> {
    return this.crystalService.updateCrystal({
      where: { id },
      data: crystalData,
    });
  }

  @Roles("admin")
  @Delete(":id")
  async deleteCrystal(
    @Param("id", ParseIntPipe) id: number,
  ): Promise<CrystalModel> {
    return this.crystalService.deleteCrystal({ id });
  }
}