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
import { Roles } from '@/auth/roles.decorator';

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
    @Roles('admin')
    create(@Body() dto: CreateConfigCategoryDto) {
        return this.configCategoriesService.create(dto);
    }

    @Patch(':id')
    @Roles('admin')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateConfigCategoryDto,
    ) {
        return this.configCategoriesService.update(id, dto);
    }

    @Delete(':id')
    @Roles('admin')
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.configCategoriesService.remove(id);
    }
}
