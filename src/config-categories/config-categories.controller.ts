import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    ParseIntPipe,
    Patch,
    Post,
} from '@nestjs/common';
import { ConfigCategoriesService } from './config-categories.service';
import { CreateConfigCategoryDto } from './dto/create-config-category.dto';
import { UpdateConfigCategoryDto } from './dto/update-config-category.dto';

@Controller('config-categories')
export class ConfigCategoriesController {
    constructor(
        private readonly configCategoriesService: ConfigCategoriesService,
    ) { }

    @Get()
    findAll() {
        return this.configCategoriesService.findAll();
    }

    @Get('product/:productId')
    findByProduct(@Param('productId', ParseIntPipe) productId: number) {
        return this.configCategoriesService.findByProduct(productId);
    }

    @Post()
    create(@Body() dto: CreateConfigCategoryDto) {
        return this.configCategoriesService.create(dto);
    }

    @Patch(':id')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateConfigCategoryDto,
    ) {
        return this.configCategoriesService.update(id, dto);
    }

    @Delete(':id')
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.configCategoriesService.remove(id);
    }
}