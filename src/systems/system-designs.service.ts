import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DiagramFamily, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { designTransaction } from '@/garage-designs/design-transaction';
import {
  DESIGN_PRICE_DECIMAL_PATTERN,
  UpdateSystemDesignsDto,
} from './dto/system-designs.dto';

export const SYSTEM_DESIGN_OPTIONS_INCLUDE = {
  include: { design: true, color: true },
  orderBy: [
    { sortOrder: 'asc' },
    { idDesign: 'asc' },
    { idDesignColor: 'asc' },
  ],
} satisfies Prisma.System$designOptionsArgs;

const positiveId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const optionKey = (idDesign: number, idDesignColor: number) =>
  `${idDesign}:${idDesignColor}`;

function priceCoefficient(value: unknown, positive: boolean): string {
  const text =
    typeof value === 'number'
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  if (
    !DESIGN_PRICE_DECIMAL_PATTERN.test(text) ||
    (positive && !/[1-9]/.test(text))
  ) {
    throw new BadRequestException(
      positive
        ? 'Design color base multiplier must be greater than zero, with at most 18 integer digits and 20 decimal digits.'
        : 'Design color amount to subtract must be zero or greater, with at most 18 integer digits and 20 decimal digits.',
    );
  }
  return text;
}

@Injectable()
export class SystemDesignsService {
  constructor(private readonly prisma: PrismaService) {}

  private async system(id: number, tx: Prisma.TransactionClient) {
    const system = await tx.system.findUnique({
      where: { id },
      include: {
        brandProduct: { include: { product: true } },
        designOptions: SYSTEM_DESIGN_OPTIONS_INCLUDE,
        designColorModifiers: { orderBy: { idDesignColor: 'asc' } },
      },
    });
    if (!system) throw new NotFoundException('System not found.');
    return system;
  }

  async manage(id: number, tx: Prisma.TransactionClient = this.prisma) {
    const system = await this.system(id, tx);
    const orderBy = [
      { sortOrder: 'asc' as const },
      { name: 'asc' as const },
      { id: 'asc' as const },
    ];
    const [designCatalog, colorCatalog] = await Promise.all([
      tx.designPattern.findMany({ orderBy }),
      tx.designColor.findMany({ orderBy }),
    ]);
    const groups = new Map<
      number,
      { designId: number; colorIds: number[]; sortOrder: number }
    >();
    for (const option of system.designOptions) {
      const group = groups.get(option.idDesign) ?? {
        designId: option.idDesign,
        colorIds: [],
        sortOrder: option.sortOrder,
      };
      group.colorIds.push(option.idDesignColor);
      groups.set(option.idDesign, group);
    }
    const { product } = system.brandProduct;
    const modifiers = new Map(
      system.designColorModifiers.map((item) => [
        item.idDesignColor,
        {
          designColorId: item.idDesignColor,
          modifierEnabled: item.modifierEnabled,
          basePriceMultiplier: item.basePriceMultiplier.toFixed(),
          basePriceDeduction: item.basePriceDeduction.toFixed(),
        },
      ]),
    );
    for (const option of system.designOptions) {
      if (!modifiers.has(option.idDesignColor))
        modifiers.set(option.idDesignColor, {
          designColorId: option.idDesignColor,
          modifierEnabled: false,
          basePriceMultiplier: '1',
          basePriceDeduction: '0',
        });
    }
    return {
      system: {
        id: system.id,
        name: system.name,
        product: {
          id: product.id,
          name: product.name,
          diagramFamily: product.diagramFamily,
        },
      },
      allowDesign: system.allowDesign,
      defaultDesignId: system.defaultDesignId,
      defaultDesignColorId: system.defaultDesignColorId,
      garageMaxSectionHeightIn: Number(system.garageMaxSectionHeightIn ?? 24),
      designs: [...groups.values()],
      colorModifiers: [...modifiers.values()],
      designCatalog,
      colorCatalog,
    };
  }

  async update(id: number, data: UpdateSystemDesignsDto) {
    if (typeof data.allowDesign !== 'boolean' || !Array.isArray(data.designs))
      throw new BadRequestException(
        'Design availability and its allowed combinations are required.',
      );
    if (
      data.colorModifiers !== undefined &&
      !Array.isArray(data.colorModifiers)
    )
      throw new BadRequestException('Design color modifiers must be an array.');
    const modifierColorIds = new Set<number>();
    const colorModifiers = (data.colorModifiers ?? []).map((item) => {
      if (
        !item ||
        !positiveId(item.designColorId) ||
        modifierColorIds.has(item.designColorId)
      )
        throw new BadRequestException(
          'Select unique, valid design colors for their modifiers.',
        );
      modifierColorIds.add(item.designColorId);
      if (typeof item.modifierEnabled !== 'boolean')
        throw new BadRequestException(
          'Design color modifier must be active or inactive.',
        );
      return {
        idDesignColor: item.designColorId,
        modifierEnabled: item.modifierEnabled,
        basePriceMultiplier: priceCoefficient(item.basePriceMultiplier, true),
        basePriceDeduction: priceCoefficient(item.basePriceDeduction, false),
      };
    });
    const sectionHeight = data.garageMaxSectionHeightIn;
    if (
      sectionHeight !== undefined &&
      (typeof sectionHeight !== 'number' ||
        !Number.isFinite(sectionHeight) ||
        sectionHeight < 1 ||
        sectionHeight > 240 ||
        Number(sectionHeight.toFixed(2)) !== sectionHeight)
    )
      throw new BadRequestException(
        'Maximum section height must be between 1 and 240 inches, with up to two decimal places.',
      );
    const patternIds = new Set<number>();
    const pairs: Array<{
      idSystem: number;
      idDesign: number;
      idDesignColor: number;
      sortOrder: number;
    }> = [];
    for (const item of data.designs) {
      if (
        !item ||
        !positiveId(item.designId) ||
        patternIds.has(item.designId) ||
        !Number.isSafeInteger(item.sortOrder) ||
        item.sortOrder < 0 ||
        !Array.isArray(item.colorIds) ||
        !item.colorIds.length ||
        item.colorIds.some((colorId) => !positiveId(colorId)) ||
        new Set(item.colorIds).size !== item.colorIds.length
      )
        throw new BadRequestException(
          'Select unique designs, at least one unique color per design, and a nonnegative sort order.',
        );
      patternIds.add(item.designId);
      pairs.push(
        ...item.colorIds.map((idDesignColor) => ({
          idSystem: id,
          idDesign: item.designId,
          idDesignColor,
          sortOrder: item.sortOrder,
        })),
      );
    }
    const defaultDesignId = data.defaultDesignId ?? null;
    const defaultDesignColorId = data.defaultDesignColorId ?? null;
    if (
      (defaultDesignId === null) !== (defaultDesignColorId === null) ||
      (defaultDesignId !== null &&
        (!positiveId(defaultDesignId) || !positiveId(defaultDesignColorId)))
    )
      throw new BadRequestException(
        'Select both a default design and its default color, or neither.',
      );
    if (data.allowDesign && defaultDesignId === null)
      throw new BadRequestException(
        'Choose an allowed active default design and color before enabling Design.',
      );
    if (
      defaultDesignId !== null &&
      !pairs.some(
        (pair) =>
          pair.idDesign === defaultDesignId &&
          pair.idDesignColor === defaultDesignColorId,
      )
    )
      throw new BadRequestException(
        'The default design/color combination must be included in the allowed combinations.',
      );

    return designTransaction(this.prisma, async (tx) => {
      const system = await this.system(id, tx);
      if (
        (data.allowDesign ||
          pairs.length ||
          colorModifiers.length ||
          defaultDesignId !== null ||
          sectionHeight !== undefined) &&
        system.brandProduct.product.diagramFamily !== DiagramFamily.GARAGE_DOOR
      )
        throw new BadRequestException(
          'Design is available only for Garage Door series.',
        );
      const colorIds = [
        ...new Set([
          ...pairs.map((pair) => pair.idDesignColor),
          ...modifierColorIds,
        ]),
      ];
      const [patterns, colors] = await Promise.all([
        tx.designPattern.findMany({ where: { id: { in: [...patternIds] } } }),
        tx.designColor.findMany({ where: { id: { in: colorIds } } }),
      ]);
      if (
        patterns.length !== patternIds.size ||
        colors.length !== colorIds.length
      )
        throw new BadRequestException(
          'One or more selected designs or colors do not exist.',
        );
      const activePatterns = new Set(
        patterns
          .filter((pattern) => pattern.isActive)
          .map((pattern) => pattern.id),
      );
      const activeColors = new Set(
        colors.filter((color) => color.isActive).map((color) => color.id),
      );
      const existing = new Set(
        system.designOptions.map((pair) =>
          optionKey(pair.idDesign, pair.idDesignColor),
        ),
      );
      if (
        pairs.some(
          (pair) =>
            (!activePatterns.has(pair.idDesign) ||
              !activeColors.has(pair.idDesignColor)) &&
            !existing.has(optionKey(pair.idDesign, pair.idDesignColor)),
        )
      )
        throw new BadRequestException(
          'New combinations must use active designs and colors. Existing inactive combinations may be retained.',
        );
      if (
        data.allowDesign &&
        (!activePatterns.has(defaultDesignId!) ||
          !activeColors.has(defaultDesignColorId!))
      )
        throw new BadRequestException(
          'The default design and color must both be active.',
        );

      // Modifiers belong to the series/color pair, independently of its selected patterns.
      // Omitted rows retain their values even when a color is temporarily unassigned.
      for (const modifier of colorModifiers) {
        const { idDesignColor, ...values } = modifier;
        await tx.systemDesignColorModifier.upsert({
          where: { idSystem_idDesignColor: { idSystem: id, idDesignColor } },
          create: { idSystem: id, idDesignColor, ...values },
          update: values,
        });
      }
      if (pairs.length)
        await tx.systemDesignColorModifier.createMany({
          data: [...new Set(pairs.map((pair) => pair.idDesignColor))].map(
            (idDesignColor) => ({ idSystem: id, idDesignColor }),
          ),
          skipDuplicates: true,
        });

      // Compatibility rows are not referenced by historical pieces; catalog IDs are.
      await tx.systemDesignOption.deleteMany({ where: { idSystem: id } });
      if (pairs.length) await tx.systemDesignOption.createMany({ data: pairs });
      await tx.system.update({
        where: { id },
        data: {
          allowDesign: data.allowDesign,
          defaultDesignId,
          defaultDesignColorId,
          ...(sectionHeight !== undefined
            ? { garageMaxSectionHeightIn: sectionHeight }
            : {}),
        },
      });
      return this.manage(id, tx);
    });
  }
}
