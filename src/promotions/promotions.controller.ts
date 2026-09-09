import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { Roles } from '@/auth/roles.decorator';
import { PromotionsService } from './promotions.service';
import { PromotionDto } from './promotions.dto';
@Controller('promotions')
export class PromotionsController {
  constructor(private service: PromotionsService) {}
  @Get('available') available(@Req() req: any) {
    return this.service.available(req.user);
  }
  @Get('available/estimate/:id') forEstimate(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.available(req.user, id);
  }
  @Get('options') @Roles('admin') options() {
    return this.service.options();
  }
  @Get() @Roles('admin') list() {
    return this.service.list();
  }
  @Post() @Roles('admin') create(@Body() dto: PromotionDto) {
    return this.service.save(dto);
  }
  @Delete(':id')
  @HttpCode(204)
  @Roles('admin')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
  @Put(':id') @Roles('admin') update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PromotionDto,
  ) {
    return this.service.save(dto, id);
  }
}
