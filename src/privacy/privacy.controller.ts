import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { Privacy as PrivacyModel } from "@prisma/client";

import { Roles } from "@/auth/roles.decorator";
import { CreatePrivacyDto } from "./dto/create-privacy.dto";
import { UpdatePrivacyDto } from "./dto/update-privacy.dto";
import { PrivacyService } from "./privacy.service";

@Controller("privacies")
export class PrivacyController {
  constructor(private readonly privacyService: PrivacyService) {}

  @Get()
  getAllPrivacies(): Promise<PrivacyModel[]> {
    return this.privacyService.privacies({});
  }

  @Get(":id")
  getPrivacyById(
    @Param("id", ParseIntPipe) id: number,
  ): Promise<PrivacyModel> {
    return this.privacyService.privacy({ id });
  }

  @Roles("admin")
  @Post()
  createPrivacy(
    @Body() privacyData: CreatePrivacyDto,
  ): Promise<PrivacyModel> {
    return this.privacyService.createPrivacy(privacyData);
  }

  @Roles("admin")
  @Patch(":id")
  updatePrivacy(
    @Param("id", ParseIntPipe) id: number,
    @Body() privacyData: UpdatePrivacyDto,
  ): Promise<PrivacyModel> {
    return this.privacyService.updatePrivacy({
      where: { id },
      data: privacyData,
    });
  }

  @Roles("admin")
  @Delete(":id")
  deletePrivacy(
    @Param("id", ParseIntPipe) id: number,
  ): Promise<PrivacyModel> {
    return this.privacyService.deletePrivacy({ id });
  }
}
