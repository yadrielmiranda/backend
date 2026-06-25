import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateConfigCategoryDto } from './dto/create-config-category.dto';
import { UpdateConfigCategoryDto } from './dto/update-config-category.dto';

@Injectable()
export class ConfigCategoriesService {
    constructor(private readonly prisma: PrismaService) { }

    async findAll() {
        return this.prisma.configCategory.findMany({
            include: {
                product: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
                _count: {
                    select: {
                        configs: true,
                    },
                },
            },
            orderBy: [
                { product: { name: 'asc' } },
                { sortOrder: 'asc' },
                { name: 'asc' },
            ],
        });
    }

    async findByProduct(productId: number) {
        return this.prisma.configCategory.findMany({
            where: {
                idProduct: productId,
                isActive: true,
            },
            orderBy: [
                { sortOrder: 'asc' },
                { name: 'asc' },
            ],
        });
    }

    async create(dto: CreateConfigCategoryDto) {
        const product = await this.prisma.product.findUnique({
            where: { id: dto.idProduct },
            select: { id: true },
        });

        if (!product) {
            throw new NotFoundException('Product not found');
        }

        return this.prisma.configCategory.create({
            data: {
                name: dto.name.trim(),
                idProduct: dto.idProduct,
                sortOrder: dto.sortOrder ?? 0,
                isActive: dto.isActive ?? true,
            },
        });
    }

    async update(id: number, dto: UpdateConfigCategoryDto) {
        const existing = await this.prisma.configCategory.findUnique({
            where: { id },
        });

        if (!existing) {
            throw new NotFoundException('Config category not found');
        }

        return this.prisma.configCategory.update({
            where: { id },
            data: {
                ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
                ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
                ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            },
        });
    }

    async remove(id: number) {
        const existing = await this.prisma.configCategory.findUnique({
            where: { id },
            include: {
                _count: {
                    select: {
                        configs: true,
                    },
                },
            },
        });

        if (!existing) {
            throw new NotFoundException('Config category not found');
        }

        if (existing._count.configs > 0) {
            throw new BadRequestException(
                'This category is assigned to configs. Remove or reassign those configs first.',
            );
        }

        return this.prisma.configCategory.delete({
            where: { id },
        });
    }
}