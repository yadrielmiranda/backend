// src/linear-pricing-rules/linear-pricing-rules.service.ts

import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { PricingMode, Prisma, ProductKind } from "@prisma/client";
import { PrismaService } from "@/prisma/prisma.service";
import { CreateLinearPricingRuleDto } from "./dto/create-linear-pricing-rule.dto";
import { UpdateLinearPricingRuleDto } from "./dto/update-linear-pricing-rule.dto";

function clampInt(v: any, def: number, min: number, max: number) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(n, min), max);
}

@Injectable()
export class LinearPricingRulesService {
    constructor(private readonly prisma: PrismaService) { }

    private readonly include = {
        brand: true,
        product: true,
        system: true,
        config: true,
    } satisfies Prisma.LinearPricingRuleInclude;

    private async validateLinearPricingCombination(data: {
        idBrand: number;
        idProduct: number;
        idSystem: number;
        idConfig: number;
    }) {
        const { idBrand, idProduct, idSystem, idConfig } = data;

        const product = await this.prisma.product.findUnique({
            where: { id: idProduct },
            select: {
                id: true,
                name: true,
                kind: true,
                pricingMode: true,
                isActive: true,
            },
        });

        if (!product) {
            throw new NotFoundException(`Product #${idProduct} not found.`);
        }

        if (!product.isActive) {
            throw new BadRequestException(`Product #${idProduct} is inactive.`);
        }

        if (
            product.kind !== ProductKind.LINEAR_MATERIAL ||
            product.pricingMode !== PricingMode.LINEAR_INCH
        ) {
            throw new BadRequestException(
                "Linear pricing rules can only be created for LINEAR_MATERIAL products with LINEAR_INCH pricing mode.",
            );
        }

        const brandProduct = await this.prisma.brandProduct.findUnique({
            where: {
                idBrand_idProduct: {
                    idBrand,
                    idProduct,
                },
            },
        });

        if (!brandProduct) {
            throw new BadRequestException(
                `Brand/Product pair not found (brandId=${idBrand}, productId=${idProduct}).`,
            );
        }

        const system = await this.prisma.system.findUnique({
            where: { id: idSystem },
            select: {
                id: true,
                idBrand: true,
                idProduct: true,
                isActive: true,
            },
        });

        if (!system) {
            throw new NotFoundException(`System #${idSystem} not found.`);
        }

        if (!system.isActive) {
            throw new BadRequestException(`System #${idSystem} is inactive.`);
        }

        if (system.idBrand !== idBrand || system.idProduct !== idProduct) {
            throw new BadRequestException(
                `System #${idSystem} does not belong to brandId=${idBrand} and productId=${idProduct}.`,
            );
        }

        const config = await this.prisma.config.findUnique({
            where: { id: idConfig },
            select: {
                id: true,
                idProduct: true,
                isActive: true,
            },
        });

        if (!config) {
            throw new NotFoundException(`Config #${idConfig} not found.`);
        }

        if (!config.isActive) {
            throw new BadRequestException(`Config #${idConfig} is inactive.`);
        }

        if (config.idProduct !== idProduct) {
            throw new BadRequestException(
                `Config #${idConfig} does not belong to productId=${idProduct}.`,
            );
        }

        const sysConf = await this.prisma.sysConf.findUnique({
            where: {
                idSystem_idConfig: {
                    idSystem,
                    idConfig,
                },
            },
            select: {
                idSystem: true,
                idConfig: true,
                requiresWidth: true,
                requiresHeight: true,
                allowScreen: true,
            },
        });

        if (!sysConf) {
            throw new BadRequestException(
                `System/Config link not found (systemId=${idSystem}, configId=${idConfig}).`,
            );
        }

        if (!sysConf.requiresWidth || sysConf.requiresHeight || sysConf.allowScreen) {
            throw new BadRequestException(
                "Linear material SysConf must require width only and cannot allow screen.",
            );
        }
    }

    async findAll(params?: {
        take?: number;
        skip?: number;
        idBrand?: number;
        idProduct?: number;
        idSystem?: number;
        idConfig?: number;
    }) {
        const take = clampInt(params?.take, 100, 1, 200);
        const skip = clampInt(params?.skip, 0, 0, 10_000);

        const where: Prisma.LinearPricingRuleWhereInput = {
            ...(params?.idBrand ? { idBrand: params.idBrand } : {}),
            ...(params?.idProduct ? { idProduct: params.idProduct } : {}),
            ...(params?.idSystem ? { idSystem: params.idSystem } : {}),
            ...(params?.idConfig ? { idConfig: params.idConfig } : {}),
        };

        return this.prisma.linearPricingRule.findMany({
            where,
            include: this.include,
            orderBy: [
                { brand: { name: "asc" } },
                { product: { name: "asc" } },
                { system: { name: "asc" } },
                { config: { conf: "asc" } },
            ],
            take,
            skip,
        });
    }

    async findOne(id: number) {
        const rule = await this.prisma.linearPricingRule.findUnique({
            where: { id },
            include: this.include,
        });

        if (!rule) {
            throw new NotFoundException(`Linear pricing rule #${id} not found.`);
        }

        return rule;
    }

    async create(data: CreateLinearPricingRuleDto) {
        await this.validateLinearPricingCombination(data);

        const minLengthIn = data.minLengthIn ?? 20;
        const maxLengthIn = data.maxLengthIn ?? 288;

        if (maxLengthIn <= minLengthIn) {
            throw new BadRequestException(
                "maxLengthIn must be greater than minLengthIn.",
            );
        }

        try {
            return await this.prisma.linearPricingRule.create({
                data: {
                    idBrand: data.idBrand,
                    idProduct: data.idProduct,
                    idSystem: data.idSystem,
                    idConfig: data.idConfig,
                    costPerInch: new Prisma.Decimal(data.costPerInch),
                    minLengthIn: new Prisma.Decimal(minLengthIn),
                    maxLengthIn: new Prisma.Decimal(maxLengthIn),
                },
                include: this.include,
            });
        } catch (e: any) {
            if (e?.code === "P2002") {
                throw new ConflictException(
                    "A linear pricing rule already exists for this Brand/Product/System/Config combination.",
                );
            }

            throw e;
        }
    }

    async update(id: number, data: UpdateLinearPricingRuleDto) {
        const current = await this.prisma.linearPricingRule.findUnique({
            where: { id },
        });

        if (!current) {
            throw new NotFoundException(`Linear pricing rule #${id} not found.`);
        }

        const nextMinLengthIn =
            data.minLengthIn !== undefined
                ? data.minLengthIn
                : Number(current.minLengthIn);

        const nextMaxLengthIn =
            data.maxLengthIn !== undefined
                ? data.maxLengthIn
                : Number(current.maxLengthIn);

        if (nextMaxLengthIn <= nextMinLengthIn) {
            throw new BadRequestException(
                "maxLengthIn must be greater than minLengthIn.",
            );
        }

        const nextData = {
            idBrand: data.idBrand ?? current.idBrand,
            idProduct: data.idProduct ?? current.idProduct,
            idSystem: data.idSystem ?? current.idSystem,
            idConfig: data.idConfig ?? current.idConfig,
        };

        await this.validateLinearPricingCombination(nextData);

        try {
            return await this.prisma.linearPricingRule.update({
                where: { id },
                data: {
                    ...(data.idBrand !== undefined ? { idBrand: data.idBrand } : {}),
                    ...(data.idProduct !== undefined ? { idProduct: data.idProduct } : {}),
                    ...(data.idSystem !== undefined ? { idSystem: data.idSystem } : {}),
                    ...(data.idConfig !== undefined ? { idConfig: data.idConfig } : {}),
                    ...(data.costPerInch !== undefined
                        ? { costPerInch: new Prisma.Decimal(data.costPerInch) }
                        : {}),
                    ...(data.minLengthIn !== undefined
                        ? { minLengthIn: new Prisma.Decimal(data.minLengthIn) }
                        : {}),

                    ...(data.maxLengthIn !== undefined
                        ? { maxLengthIn: new Prisma.Decimal(data.maxLengthIn) }
                        : {}),
                },
                include: this.include,
            });
        } catch (e: any) {
            if (e?.code === "P2002") {
                throw new ConflictException(
                    "A linear pricing rule already exists for this Brand/Product/System/Config combination.",
                );
            }

            if (e?.code === "P2025") {
                throw new NotFoundException(`Linear pricing rule #${id} not found.`);
            }

            throw e;
        }
    }

    async remove(id: number) {
        try {
            return await this.prisma.linearPricingRule.delete({
                where: { id },
                include: this.include,
            });
        } catch (e: any) {
            if (e?.code === "P2025") {
                throw new NotFoundException(`Linear pricing rule #${id} not found.`);
            }

            throw e;
        }
    }
}