import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '@/auth/roles.decorator';
import {
  CreateEnergyRatingDto,
  FindEnergyRatingsDto,
  UpdateEnergyRatingDto,
} from './dto/energy-rating.dto';
import { EnergyRatingsService } from './energy-ratings.service';

@Controller('energy-ratings')
@Roles('admin', 'operator')
export class EnergyRatingsController {
  constructor(private readonly service: EnergyRatingsService) {}

  @Get()
  findAll(@Query() query: FindEnergyRatingsDto) {
    return this.service.findAll(query);
  }

  @Get('catalog-options')
  catalogOptions() {
    return this.service.catalogOptions();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles('admin')
  create(@Body() dto: CreateEnergyRatingDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('admin')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEnergyRatingDto,
  ) {
    return this.service.update(id, dto);
  }
}
