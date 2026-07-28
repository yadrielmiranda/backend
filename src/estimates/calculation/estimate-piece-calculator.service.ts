import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import {
  DimensionMode,
  PricingComponentType,
  PricingMode,
  Prisma,
  PrismaClient,
  ProductKind,
} from "@prisma/client";

import Decimal from "decimal.js";

import { dimsInchesToFeet } from "@/pricing/units";
import { areaPerimeterFor } from "@/pricing/shape-geometry";
import { computeBasePrice } from "@/pricing/price-formula";

import { CreatePieceDto } from "@/pieces/dto/create-piece.dto";
import { UpsertPieceDto } from "../dto/upsert-piece.dto";

import { EstimateDimensionValidationService } from "../dimensions/estimate-dimension-validation.service";
import { EstimateMuntinService } from "../muntins/estimate-muntin.service";

type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

type ConfigSelect = {
  conf: string;
  requiresWidth: boolean;
  requiresHeight: boolean;
  requiresHeightLeft: boolean;
  requiresHeightRight: boolean;
  requiresLegHeight: boolean;
  requiresSashHeight: boolean;
  requiresWindowHeight: boolean;
  muntinLayout: unknown;
};

export type CalculationCache = {
  product: Map<number, any>;
  config: Map<number, ConfigSelect | null>;
  sysConf: Map<string, any>;
  pricing: Map<string, any>;
  linearPricing: Map<string, any>;
  systemFrameColor: Map<string, any>;
  highBottomSettings: Map<string, any>;
};

export type CalculatedMetricsInternal = {
  rate: Decimal;
  price: Decimal;
  netProfit: Decimal;
  markup: Decimal;
  subtotal: Decimal;
  dealerMarkupDecimal: Decimal;
  netProfitD: Decimal;
  customerPrice: Decimal;
  customerSubtotal: Decimal;
  dpPosPsf: Decimal;
  dpNegPsf: Decimal;
  highBottom: boolean;
  highBottomPercent: Decimal | null;
};

export type CalculatedPieceCombined = (CreatePieceDto | UpsertPieceDto) &
  CalculatedMetricsInternal;

export type PersistedPieceTotalsInput = {
  qty: number;
  rate: Prisma.Decimal;
  price: Prisma.Decimal;
  customerPrice: Prisma.Decimal;
  dealerMarkup: Prisma.Decimal;
};

export type EstimateTotalsResult = {
  rateT: Prisma.Decimal;
  priceT: Prisma.Decimal;
  netProfit: Prisma.Decimal;
  taxRate: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  totalPayable: Prisma.Decimal;
  customerPriceT: Prisma.Decimal;
  customerTaxRate: Prisma.Decimal;
  customerTaxAmount: Prisma.Decimal;
  customerTotalPayable: Prisma.Decimal;
  netProfitD: Prisma.Decimal;
};

type NormalizedEstimateTotalsPiece = {
  qty: number;
  rate: Decimal;
  price: Decimal;
  customerPrice: Decimal;
  dealerMarkupDecimal: Decimal;
};

const MIN_TRANSOM_HEIGHT_IN = new Decimal(10);
const MIN_WINDOW_HEIGHT_IN = new Decimal(24.125);
const MIN_FIX_HEIGHT_IN = new Decimal(12);

@Injectable()
export class EstimatePieceCalculatorService {
  constructor(
    private dimensionValidationService: EstimateDimensionValidationService,
    private muntinService: EstimateMuntinService,
  ) { }

  createCalculationCache(): CalculationCache {
    return {
      product: new Map(),
      config: new Map(),
      sysConf: new Map(),
      pricing: new Map(),
      linearPricing: new Map(),
      systemFrameColor: new Map(),
      highBottomSettings: new Map(),
    };
  }

  private valueMatchesRange(
    value: Decimal,
    minimum: Prisma.Decimal | null,
    minimumInclusive: boolean,
    maximum: Prisma.Decimal | null,
    maximumInclusive: boolean,
  ) {
    if (minimum != null) {
      const min = new Decimal(minimum.toString());

      if (value.lt(min) || (value.eq(min) && !minimumInclusive)) {
        return false;
      }
    }

    if (maximum != null) {
      const max = new Decimal(maximum.toString());

      if (value.gt(max) || (value.eq(max) && !maximumInclusive)) {
        return false;
      }
    }

    return true;
  }

  private pricingRangeMatches(
    range: {
      minWidthIn: Prisma.Decimal | null;
      minWidthInclusive: boolean;
      maxWidthIn: Prisma.Decimal | null;
      maxWidthInclusive: boolean;
      minHeightIn: Prisma.Decimal | null;
      minHeightInclusive: boolean;
      maxHeightIn: Prisma.Decimal | null;
      maxHeightInclusive: boolean;
    },
    widthIn: Decimal,
    heightIn: Decimal,
  ) {
    return (
      this.valueMatchesRange(
        widthIn,
        range.minWidthIn,
        range.minWidthInclusive,
        range.maxWidthIn,
        range.maxWidthInclusive,
      ) &&
      this.valueMatchesRange(
        heightIn,
        range.minHeightIn,
        range.minHeightInclusive,
        range.maxHeightIn,
        range.maxHeightInclusive,
      )
    );
  }

  private async getPricingRuleForConfig(
    pieceDto: CreatePieceDto | UpsertPieceDto,
    configId: number,
    widthIn: Decimal,
    heightIn: Decimal,
    label: string,
    tx: PrismaTransactionClient,
    cache: CalculationCache,
  ) {
    const crystalId = Number(pieceDto.idCryst);

    const pricingKey =
      `${pieceDto.idBrand}-${pieceDto.idProd}-` +
      `${pieceDto.idSyst}-${configId}-${crystalId}-` +
      `${widthIn.toString()}-${heightIn.toString()}`;

    let rule = cache.pricing.get(pricingKey);

    if (!rule) {
      const rangeRules = await tx.pricingRangeRule.findMany({
        where: {
          idCrystal: crystalId,
          range: {
            is: {
              idSystem: pieceDto.idSyst,
              idConfig: configId,
              isActive: true,
            },
          },
        },
        include: {
          range: true,
        },
        orderBy: {
          rangeId: "asc",
        },
      });

      const matchingRangeRules = rangeRules.filter((rangeRule) =>
        this.pricingRangeMatches(rangeRule.range, widthIn, heightIn),
      );

      if (matchingRangeRules.length > 1) {
        throw new BadRequestException(
          `More than one active pricing range matches W=${widthIn.toString()}" and H=${heightIn.toString()}" for ${label}.`,
        );
      }

      if (matchingRangeRules.length === 1) {
        rule = matchingRangeRules[0];
        cache.pricing.set(pricingKey, rule);
      } else if (rangeRules.length > 0) {
        throw new NotFoundException(
          `No active pricing range matches W=${widthIn.toString()}" and H=${heightIn.toString()}" for ${label} in piece ${pieceDto.mark}.`,
        );
      }
    }

    if (!rule) {
      const dbRule = await tx.pricingRule.findUnique({
        where: {
          idBrand_idProduct_idSystem_idConfig_idCrystal: {
            idBrand: pieceDto.idBrand,
            idProduct: pieceDto.idProd,
            idSystem: pieceDto.idSyst,
            idConfig: configId,
            idCrystal: crystalId,
          },
        },
      });

      if (dbRule) {
        cache.pricing.set(pricingKey, dbRule);
        rule = dbRule;
      }
    }

    if (!rule) {
      throw new NotFoundException(
        `No pricing rule exists for ${label} in piece ${pieceDto.mark}.`,
      );
    }

    return rule;
  }

  async calculatePieceMetrics(
    pieceDto: CreatePieceDto | UpsertPieceDto,
    effectiveMarkup: Decimal,
    tx: PrismaTransactionClient,
    cache: CalculationCache,
  ): Promise<CalculatedPieceCombined> {
    // usamos cache para evitar queries repetidas
    let product = cache.product.get(pieceDto.idProd);

    if (!product) {
      const dbProduct = await tx.product.findUnique({
        where: { id: pieceDto.idProd },
        select: {
          id: true,
          name: true,
          kind: true,
          pricingMode: true,
          isActive: true,
        },
      });

      if (dbProduct) {
        cache.product.set(pieceDto.idProd, dbProduct);
        product = dbProduct;
      }
    }

    if (!product) {
      throw new NotFoundException(`Product ID #${pieceDto.idProd} not found.`);
    }

    if (!product.isActive) {
      throw new BadRequestException(`Product #${pieceDto.idProd} is inactive.`);
    }

    if (!Number.isFinite(Number(pieceDto.qty)) || Number(pieceDto.qty) <= 0) {
      throw new BadRequestException("Quantity must be greater than zero.");
    }

    const isLinearMaterial =
      product.kind === ProductKind.LINEAR_MATERIAL &&
      product.pricingMode === PricingMode.LINEAR_INCH;

    const isGlazedUnit =
      product.kind === ProductKind.GLAZED_UNIT &&
      product.pricingMode === PricingMode.AREA_PERIMETER;

    if (!isLinearMaterial && !isGlazedUnit) {
      throw new BadRequestException(
        `Invalid product classification for Product #${pieceDto.idProd}.`,
      );
    }
    let config = cache.config.get(pieceDto.idConf);

    if (!config) {
      const dbConfig = await tx.config.findUnique({
        where: { id: pieceDto.idConf },
        select: {
          conf: true,
          requiresWidth: true,
          requiresHeight: true,
          requiresHeightLeft: true,
          requiresHeightRight: true,
          requiresLegHeight: true,
          requiresSashHeight: true,
          requiresWindowHeight: true,
          muntinLayout: true,
        },
      });

      if (dbConfig) {
        cache.config.set(pieceDto.idConf, dbConfig);
        config = dbConfig;
      }
    }

    if (!config) {
      throw new NotFoundException(`Config ID #${pieceDto.idConf} not found.`);
    }

    // validamos que la config realmente pertenezca al system
    // y leemos allowScreen desde SysConf

    const sysConfKey = `${pieceDto.idSyst}-${pieceDto.idConf}`;

    let sysConf = cache.sysConf.get(sysConfKey);

    if (!sysConf) {
      const dbSysConf = await tx.sysConf.findUnique({
        where: {
          idSystem_idConfig: {
            idSystem: pieceDto.idSyst,
            idConfig: pieceDto.idConf,
          },
        },
        select: {
          isSelectableInEstimate: true,
          allowScreen: true,
          dimensionMode: true,
          minimumBillableHeightIn: true,

          requiresWidth: true,
          requiresHeight: true,
          requiresHeightLeft: true,
          requiresHeightRight: true,
          requiresDoorWidth: true,
          requiresDoorHeight: true,
          requiresLeftSideliteWidth: true,
          requiresRightSideliteWidth: true,
          requiresLeftPanels: true,
          requiresRightPanels: true,
          requiresPanelCount: true,
          requiresHorizontalHeights: true,

          pricingComponents: {
            select: {
              componentType: true,
              sourceConfigId: true,
              quantity: true,
              sourceSysConf: {
                select: {
                  minimumBillableHeightIn: true,
                  config: {
                    select: {
                      conf: true,
                    },
                  },
                },
              },
            },
            orderBy: {
              componentType: "asc",
            },
          },

          activeOptions: { select: { optionId: true } },
          preparationOptions: { select: { optionId: true } },
          sillOptions: { select: { optionId: true } },
          reinforcementOptions: { select: { optionId: true } },
        },
      });

      if (dbSysConf) {
        cache.sysConf.set(sysConfKey, dbSysConf);
        sysConf = dbSysConf;
      }
    }

    if (!sysConf) {
      throw new BadRequestException(
        "The selected configuration does not belong to the selected system.",
      );
    }

    if (!sysConf.isSelectableInEstimate) {
      throw new BadRequestException(
        "The selected configuration is currently unavailable in estimates.",
      );
    }

    if (!pieceDto.idFC) {
      throw new BadRequestException("Frame color is required");
    }

    const sfcKey = `${pieceDto.idSyst}-${pieceDto.idFC}`;

    let systemFrameColor = cache.systemFrameColor.get(sfcKey);

    if (!systemFrameColor) {
      const dbSystemFrameColor = await tx.systemFrameColor.findUnique({
        where: {
          idSystem_idFrameColor: {
            idSystem: pieceDto.idSyst,
            idFrameColor: pieceDto.idFC,
          },
        },
        select: {
          idSystem: true,
          idFrameColor: true,
        },
      });

      if (dbSystemFrameColor) {
        cache.systemFrameColor.set(sfcKey, dbSystemFrameColor);
        systemFrameColor = dbSystemFrameColor;
      }
    }

    if (!systemFrameColor) {
      throw new BadRequestException(
        "The selected frame color is not available for the selected system.",
      );
    }

    if (isLinearMaterial) {
      if (!pieceDto.width) {
        throw new BadRequestException("Width is required for linear material.");
      }

      if (pieceDto.screen) {
        throw new BadRequestException(
          "Screen is not allowed for linear material.",
        );
      }

      if ((pieceDto as any).muntin) {
        throw new BadRequestException(
          "Muntins are not allowed for linear material.",
        );
      }

      if ((pieceDto as any).highBottom) {
        throw new BadRequestException(
          "High Bottom is not allowed for linear material.",
        );
      }

      if (pieceDto.idCryst || pieceDto.idTint || pieceDto.idCoat) {
        throw new BadRequestException(
          "Glass, tint and coating are not allowed for linear material.",
        );
      }

      const linearPricingKey = `${pieceDto.idBrand}-${pieceDto.idProd}-${pieceDto.idSyst}-${pieceDto.idConf}`;

      let linearRule = cache.linearPricing.get(linearPricingKey);

      if (!linearRule) {
        const dbLinearRule = await tx.linearPricingRule.findUnique({
          where: {
            idBrand_idProduct_idSystem_idConfig: {
              idBrand: pieceDto.idBrand,
              idProduct: pieceDto.idProd,
              idSystem: pieceDto.idSyst,
              idConfig: pieceDto.idConf,
            },
          },
        });

        if (dbLinearRule) {
          cache.linearPricing.set(linearPricingKey, dbLinearRule);
          linearRule = dbLinearRule;
        }
      }

      if (!linearRule) {
        throw new NotFoundException(
          `No linear pricing rule for piece: ${pieceDto.mark}.`,
        );
      }

      const widthIn = new Decimal(String(pieceDto.width));

      if (widthIn.lte(0)) {
        throw new BadRequestException(
          "Width must be greater than zero for linear material.",
        );
      }

      const minLengthIn = new Decimal(linearRule.minLengthIn.toString());
      const maxLengthIn = new Decimal(linearRule.maxLengthIn.toString());

      if (widthIn.lt(minLengthIn) || widthIn.gt(maxLengthIn)) {
        throw new BadRequestException(
          `Linear material length must be between ${minLengthIn.toString()} and ${maxLengthIn.toString()} inches.`,
        );
      }

      const costPerInch = new Decimal(linearRule.costPerInch.toString());

      const rate = widthIn.mul(costPerInch);

      const markupAmount = rate.mul(effectiveMarkup);
      const price = rate.add(markupAmount);
      const netProfit = price.sub(rate);

      const dealerMarkupFromDto = new Decimal(
        (pieceDto as any).dealerMarkup || 0,
      );
      const dealerMarkupDecimal = dealerMarkupFromDto.div(100);

      const qtyDec = new Decimal(pieceDto.qty || 1);

      const rateR = rate.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const priceR = price.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const netProfitR = netProfit.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const markupR = effectiveMarkup.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      const dealerMarkupDecimalR = dealerMarkupDecimal.toDecimalPlaces(
        4,
        Decimal.ROUND_HALF_UP,
      );

      const subtotalR = priceR
        .mul(qtyDec)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const netProfitDR = subtotalR
        .mul(dealerMarkupDecimalR)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const customerSubtotalR = subtotalR
        .add(netProfitDR)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

      const customerPriceR = qtyDec.gt(0)
        ? customerSubtotalR
          .div(qtyDec)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        : new Decimal(0);

      const result: CalculatedPieceCombined = {
        ...(pieceDto as any),

        idCryst: null,
        idTint: null,
        idCoat: null,
        privacy: false,
        screen: false,
        highBottom: false,
        highBottomPercent: null,
        muntin: null,

        height: null,
        heightLeft: null,
        heightRight: null,
        legHeight: null,
        sashHeight: null,
        windowHeight: null,

        doorWidth: null,
        doorHeight: null,
        leftSideliteWidth: null,
        rightSideliteWidth: null,
        leftPanels: null,
        rightPanels: null,
        panelCount: null,
        horizontalHeights: null,

        idActiveOption: null,
        idPreparationOption: null,
        idSillOption: null,
        idReinforcementOption: null,

        rate: rateR,
        price: priceR,
        netProfit: netProfitR,
        markup: markupR,
        dealerMarkupDecimal: dealerMarkupDecimalR,
        netProfitD: netProfitDR,
        subtotal: subtotalR,
        customerPrice: customerPriceR,
        customerSubtotal: customerSubtotalR,
        dpPosPsf: new Decimal(0),
        dpNegPsf: new Decimal(0),
      };

      return result;
    }

    if (!pieceDto.idCryst) {
      throw new BadRequestException("Glass is required.");
    }

    if (!pieceDto.idTint) {
      throw new BadRequestException("Tint is required.");
    }

    if (!pieceDto.idCoat) {
      throw new BadRequestException("Coating is required.");
    }

    // screen solo se permite si SysConf.allowScreen = true
    if (pieceDto.screen && !sysConf.allowScreen) {
      throw new BadRequestException(
        "Screen is not allowed for the selected configuration.",
      );
    }

    const highBottom = (pieceDto as any).highBottom === true;

    const highBottomSettingsKey = `${pieceDto.idBrand}-${pieceDto.idSyst}`;

    let highBottomSettings = cache.highBottomSettings.get(
      highBottomSettingsKey,
    );

    if (!highBottomSettings) {
      const dbSystem = await tx.system.findUnique({
        where: { id: pieceDto.idSyst },
        select: {
          id: true,
          idBrand: true,
          allowHighBottom: true,
          brandProduct: {
            select: {
              brand: {
                select: {
                  id: true,
                  highBottomPercent: true,
                },
              },
            },
          },
        },
      });

      if (dbSystem) {
        cache.highBottomSettings.set(highBottomSettingsKey, dbSystem);
        highBottomSettings = dbSystem;
      }
    }

    if (!highBottomSettings) {
      throw new NotFoundException(`System ID #${pieceDto.idSyst} not found.`);
    }

    if (highBottomSettings.idBrand !== pieceDto.idBrand) {
      throw new BadRequestException(
        "The selected System does not belong to the selected Brand.",
      );
    }

    const brandHighBottomPercent =
      highBottomSettings.brandProduct?.brand?.highBottomPercent == null
        ? null
        : new Decimal(
          highBottomSettings.brandProduct.brand.highBottomPercent.toString(),
        );

    if (highBottom && !highBottomSettings.allowHighBottom) {
      throw new BadRequestException(
        "High Bottom is not allowed for the selected System.",
      );
    }

    if (
      highBottom &&
      (!brandHighBottomPercent || brandHighBottomPercent.lte(0))
    ) {
      throw new BadRequestException(
        "High Bottom percentage is not configured for this Brand.",
      );
    }

    const highBottomPercent = highBottom ? brandHighBottomPercent! : null;

    const allowedActiveOptionIds = new Set<number>(
      sysConf.activeOptions.map((x) => x.optionId),
    );

    const allowedPreparationOptionIds = new Set<number>(
      sysConf.preparationOptions.map((x) => x.optionId),
    );

    const allowedSillOptionIds = new Set<number>(
      sysConf.sillOptions.map((x) => x.optionId),
    );

    const allowedReinforcementOptionIds = new Set<number>(
      sysConf.reinforcementOptions.map((x) => x.optionId),
    );

    const validateSingleSysConfOption = (
      label: string,
      selectedId: number | undefined | null,
      allowedIds: Set<number>,
    ) => {
      // si este SysConf no tiene opciones para ese campo, no permitimos que manden un valor
      if (allowedIds.size === 0) {
        if (selectedId != null) {
          throw new BadRequestException(
            `${label} is not allowed for the selected configuration.`,
          );
        }
        return;
      }

      // si el SysConf si tiene opciones configuradas, exigimos que el usuario seleccione una valida
      if (selectedId == null) {
        throw new BadRequestException(
          `${label} is required for the selected configuration.`,
        );
      }

      if (!allowedIds.has(selectedId)) {
        throw new BadRequestException(
          `${label} is invalid for the selected configuration.`,
        );
      }
    };

    validateSingleSysConfOption(
      "Active option",
      pieceDto.idActiveOption,
      allowedActiveOptionIds,
    );

    validateSingleSysConfOption(
      "Preparation option",
      pieceDto.idPreparationOption,
      allowedPreparationOptionIds,
    );

    validateSingleSysConfOption(
      "Sill option",
      pieceDto.idSillOption,
      allowedSillOptionIds,
    );

    validateSingleSysConfOption(
      "Reinforcement option",
      pieceDto.idReinforcementOption,
      allowedReinforcementOptionIds,
    );

    const normalizedMuntin =
      await this.muntinService.normalizePieceMuntinFromCatalog(
        pieceDto.muntin,
        config.muntinLayout,
        tx as any,
      );

    const need = (v?: number | boolean | null) => v === 1 || v === true;
    const missing: string[] = [];

    const dimensionMode: DimensionMode =
      sysConf.dimensionMode ?? DimensionMode.STANDARD;

    const resolveBillableHeight = (
      actualHeight: Decimal,
      minimumHeightValue: unknown,
    ): Decimal => {
      if (minimumHeightValue == null || minimumHeightValue === "") {
        return actualHeight;
      }

      const minimumHeight = new Decimal(String(minimumHeightValue));

      if (!minimumHeight.isFinite() || minimumHeight.lte(0)) {
        throw new BadRequestException(
          "Minimum billable height must be greater than zero.",
        );
      }

      return Decimal.max(actualHeight, minimumHeight);
    };

    const isBlank = (value: unknown) => value == null || value === "";

    const requireField = (
      enabled: boolean,
      fieldName: string,
      value: unknown,
    ) => {
      if (enabled && isBlank(value)) {
        missing.push(fieldName);
      }
    };

    if (dimensionMode === DimensionMode.STANDARD) {
      // comentario en espanol: comportamiento viejo intacto para configs normales
      if (need(config.requiresWidth) && isBlank(pieceDto.width)) {
        missing.push("width");
      }

      if (need(config.requiresHeight) && isBlank(pieceDto.height)) {
        missing.push("height");
      }

      if (need(config.requiresHeightLeft) && isBlank(pieceDto.heightLeft)) {
        missing.push("heightLeft");
      }

      if (need(config.requiresHeightRight) && isBlank(pieceDto.heightRight)) {
        missing.push("heightRight");
      }

      if (need(config.requiresLegHeight) && isBlank(pieceDto.legHeight)) {
        missing.push("legHeight");
      }

      if (
        need(config.requiresSashHeight) &&
        isBlank((pieceDto as any).sashHeight)
      ) {
        missing.push("sashHeight");
      }
      if (
        need(config.requiresWindowHeight) &&
        isBlank((pieceDto as any).windowHeight)
      ) {
        missing.push("windowHeight");
      }
    } else {
      // comentario en espanol: modos nuevos usan SysConf, no nombres como X/OX/XO
      requireField(sysConf.requiresWidth, "width", pieceDto.width);
      requireField(sysConf.requiresHeight, "height", pieceDto.height);
      requireField(
        sysConf.requiresHeightLeft,
        "heightLeft",
        pieceDto.heightLeft,
      );
      requireField(
        sysConf.requiresHeightRight,
        "heightRight",
        pieceDto.heightRight,
      );

      requireField(
        sysConf.requiresDoorWidth,
        "doorWidth",
        (pieceDto as any).doorWidth,
      );

      requireField(
        sysConf.requiresDoorHeight,
        "doorHeight",
        (pieceDto as any).doorHeight,
      );

      requireField(
        sysConf.requiresLeftSideliteWidth,
        "leftSideliteWidth",
        (pieceDto as any).leftSideliteWidth,
      );

      requireField(
        sysConf.requiresRightSideliteWidth,
        "rightSideliteWidth",
        (pieceDto as any).rightSideliteWidth,
      );

      requireField(
        sysConf.requiresLeftPanels,
        "leftPanels",
        (pieceDto as any).leftPanels,
      );

      requireField(
        sysConf.requiresRightPanels,
        "rightPanels",
        (pieceDto as any).rightPanels,
      );

      requireField(
        sysConf.requiresPanelCount,
        "panelCount",
        (pieceDto as any).panelCount,
      );
    }

    if (missing.length) {
      throw new BadRequestException(
        `Missing required dimensions: ${missing.join(", ")}`,
      );
    }

    // comentario en español: estas dimensiones pertenecen exclusivamente
    // a Config en modo STANDARD. Limpiamos cualquier valor obsoleto.
    const mutablePieceDto = pieceDto as any;

    if (
      dimensionMode !== DimensionMode.STANDARD ||
      !need(config.requiresLegHeight)
    ) {
      mutablePieceDto.legHeight = null;
    }

    if (
      dimensionMode !== DimensionMode.STANDARD ||
      !need(config.requiresSashHeight)
    ) {
      mutablePieceDto.sashHeight = null;
    }

    if (
      dimensionMode !== DimensionMode.STANDARD ||
      !need(config.requiresWindowHeight)
    ) {
      mutablePieceDto.windowHeight = null;
    }

    if (
      dimensionMode === DimensionMode.WINDOW_WALL &&
      sysConf.requiresHorizontalHeights &&
      Array.isArray((pieceDto as any).horizontalHeights) &&
      (pieceDto as any).horizontalHeights.length > 0
    ) {
      const horizontalHeightsRaw = (pieceDto as any).horizontalHeights;

      const totalHeightForHorizontals = Number((pieceDto as any).height || 0);

      if (
        !Number.isFinite(totalHeightForHorizontals) ||
        totalHeightForHorizontals <= 0
      ) {
        throw new BadRequestException(
          "Height is required to validate Horizontal Heights.",
        );
      }

      const horizontalHeights = horizontalHeightsRaw.map(
        (value: unknown, index: number) => ({
          value: Number(value),
          index,
        }),
      );

      const invalidNumber = horizontalHeights.find(
        (item) => !Number.isFinite(item.value),
      );

      if (invalidNumber) {
        throw new BadRequestException(
          `Horizontal Height ${invalidNumber.index + 1} must be a valid number.`,
        );
      }

      const sortedHorizontalHeights = [...horizontalHeights].sort(
        (a, b) => a.value - b.value,
      );

      const outOfRange = sortedHorizontalHeights.find(
        (item) => item.value <= 0 || item.value >= totalHeightForHorizontals,
      );

      if (outOfRange) {
        throw new BadRequestException(
          `Horizontal Height ${outOfRange.index + 1} must be greater than 0 and less than Height.`,
        );
      }

      const duplicate = sortedHorizontalHeights.find(
        (item, idx) =>
          idx > 0 && item.value === sortedHorizontalHeights[idx - 1].value,
      );

      if (duplicate) {
        throw new BadRequestException(
          "Horizontal Heights cannot contain duplicate positions.",
        );
      }

      const horizontalPoints = [
        0,
        ...sortedHorizontalHeights.map((item) => item.value),
        totalHeightForHorizontals,
      ];

      const invalidGapIndex = horizontalPoints.findIndex((point, idx) => {
        if (idx === 0) return false;

        return point - horizontalPoints[idx - 1] < 18;
      });

      if (invalidGapIndex !== -1) {
        const from = horizontalPoints[invalidGapIndex - 1];
        const to = horizontalPoints[invalidGapIndex];

        throw new BadRequestException(
          `The space between ${from}" and ${to}" cannot be less than 18 inches.`,
        );
      }
    }

    const MIN_SASH_HEIGHT_IN = new Decimal(19.625);

    const sashHeightRaw = (pieceDto as any).sashHeight;
    const totalHeightRaw = pieceDto.height;

    if (!isBlank(sashHeightRaw)) {
      const sashHeight = new Decimal(String(sashHeightRaw));

      if (sashHeight.lt(MIN_SASH_HEIGHT_IN)) {
        throw new BadRequestException(
          `Sash Height cannot be less than ${MIN_SASH_HEIGHT_IN.toString()} inches.`,
        );
      }

      if (isBlank(totalHeightRaw)) {
        throw new BadRequestException(
          "Height is required to validate Sash Height.",
        );
      }

      const totalHeight = new Decimal(String(totalHeightRaw));

      if (totalHeight.lte(0)) {
        throw new BadRequestException(
          "Height must be greater than zero to validate Sash Height.",
        );
      }

      const maxSashHeight = totalHeight.div(2);

      if (sashHeight.gt(maxSashHeight)) {
        throw new BadRequestException(
          `Sash Height cannot be greater than half of the total height (${maxSashHeight.toDecimalPlaces(3).toString()} inches).`,
        );
      }
    }

    const windowHeightRaw = (pieceDto as any).windowHeight;
    const openHeightRaw = pieceDto.height;

    if (
      need(config.requiresWindowHeight) &&
      !isBlank(windowHeightRaw)
    ) {
      const windowHeight = new Decimal(String(windowHeightRaw));

      if (windowHeight.lt(MIN_WINDOW_HEIGHT_IN)) {
        throw new BadRequestException(
          `Window Height must be at least ${MIN_WINDOW_HEIGHT_IN.toString()} inches.`,
        );
      }

      if (isBlank(openHeightRaw)) {
        throw new BadRequestException(
          "Open Height is required to validate Window Height.",
        );
      }

      const openHeight = new Decimal(String(openHeightRaw));
      const fixHeight = openHeight.minus(windowHeight);

      if (fixHeight.lt(MIN_FIX_HEIGHT_IN)) {
        throw new BadRequestException(
          `FIX Height (Open Height - Window Height) must be at least ${MIN_FIX_HEIGHT_IN.toString()} inches.`,
        );
      }
    }

    const doorHeightRaw = (pieceDto as any).doorHeight;
    const openingHeightRaw = pieceDto.height;

    if (sysConf.requiresDoorHeight && !isBlank(doorHeightRaw)) {
      const doorHeight = new Decimal(String(doorHeightRaw));

      if (doorHeight.lte(0)) {
        throw new BadRequestException("Door Height must be greater than zero.");
      }

      if (!isBlank(openingHeightRaw)) {
        const openingHeight = new Decimal(String(openingHeightRaw));
        const transomHeight = openingHeight.minus(doorHeight);

        if (transomHeight.lt(MIN_TRANSOM_HEIGHT_IN)) {
          throw new BadRequestException(
            `Transom Height (Opening Height - Door Height) must be at least ${MIN_TRANSOM_HEIGHT_IN.toString()} inches.`,
          );
        }
      }
    }

    const governingDims =
      await this.dimensionValidationService.computeGoverningDimsFromConfig(
        pieceDto,
        tx as any,
      );

    const windowWallPanelCount =
      dimensionMode === DimensionMode.WINDOW_WALL
        ? Number((pieceDto as any).panelCount)
        : 1;

    if (
      !Number.isInteger(windowWallPanelCount) ||
      windowWallPanelCount < 1
    ) {
      throw new BadRequestException(
        "Panel Count must be a whole number greater than zero.",
      );
    }

    const directPricingWidthIn =
      dimensionMode === DimensionMode.WINDOW_WALL
        ? new Decimal(String(governingDims.widthIn)).div(
          windowWallPanelCount,
        )
        : new Decimal(String(governingDims.widthIn));

    const directPricingHeight =
      dimensionMode === DimensionMode.STANDARD
        ? pieceDto.height == null
          ? pieceDto.height
          : resolveBillableHeight(
            new Decimal(String(pieceDto.height)),
            sysConf.minimumBillableHeightIn,
          ).toString()
        : resolveBillableHeight(
          new Decimal(String(governingDims.heightIn)),
          sysConf.minimumBillableHeightIn,
        ).toString();

    const dimsFt =
      dimensionMode === DimensionMode.STANDARD
        ? dimsInchesToFeet({
          width: pieceDto.width,
          height: directPricingHeight,
          heightLeft: pieceDto.heightLeft,
          heightRight: pieceDto.heightRight,
          legHeight: pieceDto.legHeight,
        })
        : dimsInchesToFeet({
          width: directPricingWidthIn.toString(),
          height: directPricingHeight,
        });

    const dpCheck =
      await this.dimensionValidationService.validateAgainstDimensionPolicy(
        pieceDto,
        tx as any,
      );
    if (!dpCheck.ok) {
      if (dpCheck.reason === "NOT_RATED") {
        throw new BadRequestException(
          dpCheck.note ??
          "No dimension policy exists for this System + Config + Crystal combination.",
        );
      }

      if (dpCheck.reason === "OVERSIZE") {
        const minW = dpCheck.suggestion?.minWidthIn;
        const minH = dpCheck.suggestion?.minHeightIn;
        const hasMinSuggestion = minW != null || minH != null;

        if (hasMinSuggestion) {
          const sug = ` Minimum allowed size: W=${minW ?? "-"}″, H=${minH ?? "-"}″.`;
          throw new BadRequestException(`Please review the dimensions.${sug}`);
        }

        const maxW = dpCheck.suggestion?.maxWidthIn;
        const maxH = dpCheck.suggestion?.maxHeightIn;
        const hasMaxSuggestion = maxW != null || maxH != null;

        const sug = hasMaxSuggestion
          ? ` Maximum allowed size: W=${maxW ?? "-"}″, H=${maxH ?? "-"}″.`
          : "";

        throw new BadRequestException(
          `The piece exceeds the NOA limits for this combination.${sug}`,
        );
      }
    }

    const dpPosPsf = new Decimal(dpCheck.dpPos ?? 0).toDecimalPlaces(
      2,
      Decimal.ROUND_HALF_UP,
    );
    const dpNegPsf = new Decimal(dpCheck.dpNeg ?? 0).toDecimalPlaces(
      2,
      Decimal.ROUND_HALF_UP,
    );

    const { areaFt2, perimeterFt } = areaPerimeterFor(config.conf, dimsFt);

    const pricingComponents = sysConf.pricingComponents ?? [];

    let baseRate: Decimal;

    if (pricingComponents.length === 0) {
      // XT/XXT se cotiza aquí como una sola pieza con Width + Opening Height.
      // Los rangos se evalúan con las dimensiones facturables.
      const pricingWidthIn = directPricingWidthIn;

      const pricingHeightIn = resolveBillableHeight(
        new Decimal(String(governingDims.heightIn)),
        sysConf.minimumBillableHeightIn,
      );

      const rule = await this.getPricingRuleForConfig(
        pieceDto,
        pieceDto.idConf,
        pricingWidthIn,
        pricingHeightIn,
        `configuration ${config.conf}`,
        tx,
        cache,
      );

      const A = new Decimal(rule.costoA.toString());
      const B = new Decimal(rule.costoB.toString());
      const C = new Decimal(rule.costoC.toString());

      const directBaseRate = computeBasePrice(
        new Decimal(areaFt2),
        new Decimal(perimeterFt),
        A,
        B,
        C,
      );

      baseRate =
        dimensionMode === DimensionMode.WINDOW_WALL
          ? directBaseRate
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
            .mul(windowWallPanelCount)
          : directBaseRate;
    } else {
      // Cada componente se redondea a centavos antes de sumarlo.
      const componentPrices: Decimal[] = [];

      const isBlankPricingDimension = (value: unknown) =>
        value == null || value === "";

      const positiveDimension = (value: unknown, label: string): Decimal => {
        if (isBlankPricingDimension(value)) {
          throw new BadRequestException(
            `${label} is required for component pricing.`,
          );
        }

        const dimension = new Decimal(String(value));

        if (!dimension.isFinite() || dimension.lte(0)) {
          throw new BadRequestException(`${label} must be greater than zero.`);
        }

        return dimension;
      };

      const computeRoundedComponentPrice = async (
        component: (typeof pricingComponents)[number],
        widthIn: Decimal,
        heightIn: Decimal,
        label: string,
      ): Promise<Decimal> => {
        if (widthIn.lte(0) || heightIn.lte(0)) {
          throw new BadRequestException(
            `${label} dimensions must be greater than zero.`,
          );
        }

        const billableHeightIn = resolveBillableHeight(
          heightIn,
          component.sourceSysConf.minimumBillableHeightIn,
        );

        const rule = await this.getPricingRuleForConfig(
          pieceDto,
          component.sourceConfigId,
          widthIn,
          billableHeightIn,
          label,
          tx,
          cache,
        );

        const componentDimsFt = dimsInchesToFeet({
          width: widthIn.toString(),
          height: billableHeightIn.toString(),
        });

        const componentGeometry = areaPerimeterFor(
          component.sourceSysConf.config.conf,
          componentDimsFt,
        );

        const componentBasePrice = computeBasePrice(
          new Decimal(componentGeometry.areaFt2),
          new Decimal(componentGeometry.perimeterFt),
          new Decimal(rule.costoA.toString()),
          new Decimal(rule.costoB.toString()),
          new Decimal(rule.costoC.toString()),
        );

        return componentBasePrice.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      };

      const totalWidth = new Decimal(String(governingDims.widthIn));

      const totalHeight = new Decimal(String(governingDims.heightIn));

      const hasSidelite = pricingComponents.some(
        (component) =>
          component.componentType === PricingComponentType.SIDELITE,
      );

      for (const component of pricingComponents) {
        if (component.componentType === PricingComponentType.DOOR) {
          let doorWidth: Decimal;

          // Eco Windows utiliza el ancho completo de la abertura
          // cuando la configuración no tiene sidelites.
          if (
            dimensionMode === DimensionMode.ECO_WINDOWS_DOOR &&
            !hasSidelite
          ) {
            doorWidth = totalWidth;
          } else {
            doorWidth = positiveDimension(
              (pieceDto as any).doorWidth,
              "Door Width",
            );
          }

          componentPrices.push(
            await computeRoundedComponentPrice(
              component,
              doorWidth,
              totalHeight,
              "DOOR component",
            ),
          );

          continue;
        }

        if (component.componentType === PricingComponentType.SIDELITE) {
          if (dimensionMode === DimensionMode.ECO_WINDOWS_DOOR) {
            const sideliteQuantity = Number(component.quantity ?? 0);

            if (!Number.isInteger(sideliteQuantity) || sideliteQuantity < 1) {
              throw new BadRequestException(
                "Sidelite Quantity must be a whole number greater than zero for Eco Windows component pricing.",
              );
            }

            const doorWidth = positiveDimension(
              (pieceDto as any).doorWidth,
              "Door Width",
            );

            const remainingWidth = totalWidth.sub(doorWidth);

            if (remainingWidth.lte(0)) {
              throw new BadRequestException(
                "Opening Width must be greater than Door Width when sidelite pricing is used.",
              );
            }

            const sideliteWidth = remainingWidth.div(sideliteQuantity);

            const panelPrice = await computeRoundedComponentPrice(
              component,
              sideliteWidth,
              totalHeight,
              "SIDELITE component",
            );

            // Cada panel se redondea primero y después se suma.
            componentPrices.push(panelPrice.mul(sideliteQuantity));

            continue;
          }

          if (dimensionMode === DimensionMode.ECO_NOVO_DOOR) {
            let totalSidelitePanels = 0;

            const addSideliteSide = async (
              widthValue: unknown,
              quantityValue: unknown,
              sideLabel: string,
            ) => {
              const quantity = Number(quantityValue ?? 0);
              const hasWidth = !isBlankPricingDimension(widthValue);

              if (!hasWidth && quantity > 0) {
                throw new BadRequestException(
                  `${sideLabel} Width is required.`,
                );
              }

              if (!hasWidth) {
                return;
              }

              if (!Number.isInteger(quantity) || quantity < 1) {
                throw new BadRequestException(
                  `${sideLabel} Qty must be a whole number greater than zero.`,
                );
              }

              const sideliteWidth = positiveDimension(
                widthValue,
                `${sideLabel} Width`,
              );

              const panelPrice = await computeRoundedComponentPrice(
                component,
                sideliteWidth,
                totalHeight,
                `SIDELITE component (${sideLabel.toLowerCase()})`,
              );

              // El precio unitario ya está redondeado.
              componentPrices.push(panelPrice.mul(quantity));

              totalSidelitePanels += quantity;
            };

            await addSideliteSide(
              (pieceDto as any).leftSideliteWidth,
              (pieceDto as any).leftPanels,
              "Left Sidelite",
            );

            await addSideliteSide(
              (pieceDto as any).rightSideliteWidth,
              (pieceDto as any).rightPanels,
              "Right Sidelite",
            );

            if (totalSidelitePanels === 0) {
              throw new BadRequestException(
                "At least one sidelite panel is required for SIDELITE component pricing.",
              );
            }

            continue;
          }

          throw new BadRequestException(
            "SIDELITE component pricing is not supported for this dimension mode.",
          );
        }

        throw new BadRequestException(
          `Unsupported pricing component type: ${component.componentType}.`,
        );
      }

      baseRate = componentPrices.reduce(
        (total, componentPrice) => total.add(componentPrice),
        new Decimal(0),
      );
    }

    const rate = highBottomPercent
      ? baseRate.mul(new Decimal(1).add(highBottomPercent.div(100)))
      : baseRate;

    const markupAmount = rate.mul(effectiveMarkup);
    const price = rate.add(markupAmount);
    const netProfit = price.sub(rate);

    const dealerMarkupFromDto = new Decimal(
      (pieceDto as any).dealerMarkup || 0,
    );
    const dealerMarkupDecimal = dealerMarkupFromDto.div(100);

    const qtyDec = new Decimal(pieceDto.qty || 1);

    const rateR = rate.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const priceR = price.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const netProfitR = netProfit.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const markupR = effectiveMarkup.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    const dealerMarkupDecimalR = dealerMarkupDecimal.toDecimalPlaces(
      4,
      Decimal.ROUND_HALF_UP,
    );

    const subtotalR = priceR
      .mul(qtyDec)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const netProfitDR = subtotalR
      .mul(dealerMarkupDecimalR)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const customerSubtotalR = subtotalR
      .add(netProfitDR)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const customerPriceR = qtyDec.gt(0)
      ? customerSubtotalR.div(qtyDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      : new Decimal(0);

    const result: CalculatedPieceCombined = {
      ...(pieceDto as any),
      muntin: normalizedMuntin,
      highBottom,
      highBottomPercent: highBottomPercent
        ? highBottomPercent.toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
        : null,

      rate: rateR,
      price: priceR,
      netProfit: netProfitR,
      markup: markupR,
      dealerMarkupDecimal: dealerMarkupDecimalR,
      netProfitD: netProfitDR,
      subtotal: subtotalR,
      customerPrice: customerPriceR,
      customerSubtotal: customerSubtotalR,
      dpPosPsf,
      dpNegPsf,
    };

    return result;
  }

  calculateEstimateTotals(
    pieces: CalculatedPieceCombined[],
    factoryTaxRate: Decimal,
    customerTaxRate: Decimal,
  ): EstimateTotalsResult {
    const normalizedPieces: NormalizedEstimateTotalsPiece[] = pieces.map(
      (piece) => ({
        qty: piece.qty,
        rate: piece.rate,
        price: piece.price,
        customerPrice: piece.customerPrice,
        dealerMarkupDecimal: piece.dealerMarkupDecimal,
      }),
    );

    return this.calculateNormalizedEstimateTotals(
      normalizedPieces,
      factoryTaxRate,
      customerTaxRate,
    );
  }

  calculateEstimateTotalsFromPersistedPieces(
    pieces: PersistedPieceTotalsInput[],
    factoryTaxRate: Decimal,
    customerTaxRate: Decimal,
  ): EstimateTotalsResult {
    const normalizedPieces: NormalizedEstimateTotalsPiece[] = pieces.map(
      (piece) => ({
        qty: piece.qty,
        rate: new Decimal(piece.rate.toString()),
        price: new Decimal(piece.price.toString()),
        customerPrice: new Decimal(piece.customerPrice.toString()),

        // comentario en español: dealerMarkup ya está guardado
        // en DB como fracción decimal, por ejemplo 0.1500.
        dealerMarkupDecimal: new Decimal(piece.dealerMarkup.toString()),
      }),
    );

    return this.calculateNormalizedEstimateTotals(
      normalizedPieces,
      factoryTaxRate,
      customerTaxRate,
    );
  }

  private calculateNormalizedEstimateTotals(
    pieces: NormalizedEstimateTotalsPiece[],
    factoryTaxRate: Decimal,
    customerTaxRate: Decimal,
  ): EstimateTotalsResult {
    const totals = pieces.reduce(
      (acc, piece) => {
        const qty = new Decimal(piece.qty || 0);

        acc.rateT = acc.rateT.add(piece.rate.mul(qty));
        acc.priceT = acc.priceT.add(piece.price.mul(qty));

        acc.customerPriceT = acc.customerPriceT.add(
          piece.customerPrice.mul(qty),
        );

        const dealerProfitPiece = piece.price.mul(piece.dealerMarkupDecimal);

        acc.netProfitD = acc.netProfitD.add(dealerProfitPiece.mul(qty));

        return acc;
      },
      {
        rateT: new Decimal(0),
        priceT: new Decimal(0),
        customerPriceT: new Decimal(0),
        netProfitD: new Decimal(0),
      },
    );

    const yourNetProfit = totals.priceT.sub(totals.rateT);

    const taxAmount = totals.priceT.mul(factoryTaxRate);
    const totalPayable = totals.priceT.add(taxAmount);

    const customerTaxAmount = totals.customerPriceT.mul(customerTaxRate);

    const customerTotalPayable = totals.customerPriceT.add(customerTaxAmount);

    return {
      rateT: new Prisma.Decimal(totals.rateT.toFixed(2)),
      priceT: new Prisma.Decimal(totals.priceT.toFixed(2)),
      netProfit: new Prisma.Decimal(yourNetProfit.toFixed(2)),

      taxRate: new Prisma.Decimal(factoryTaxRate.toFixed(4)),
      taxAmount: new Prisma.Decimal(taxAmount.toFixed(2)),
      totalPayable: new Prisma.Decimal(totalPayable.toFixed(2)),

      customerPriceT: new Prisma.Decimal(totals.customerPriceT.toFixed(2)),
      customerTaxRate: new Prisma.Decimal(customerTaxRate.toFixed(4)),
      customerTaxAmount: new Prisma.Decimal(customerTaxAmount.toFixed(2)),
      customerTotalPayable: new Prisma.Decimal(customerTotalPayable.toFixed(2)),

      netProfitD: new Prisma.Decimal(totals.netProfitD.toFixed(2)),
    };
  }
}
