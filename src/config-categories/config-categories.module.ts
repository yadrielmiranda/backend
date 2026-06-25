import { Module } from '@nestjs/common';
import { ConfigCategoriesController } from './config-categories.controller';
import { ConfigCategoriesService } from './config-categories.service';
import { PrismaModule } from '@/prisma/prisma.module';

@Module({
    imports: [PrismaModule],
    controllers: [ConfigCategoriesController],
    providers: [ConfigCategoriesService],
    exports: [ConfigCategoriesService],
})
export class ConfigCategoriesModule { }