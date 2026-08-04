import {
  DimensionMode,
  PricingComponentType,
} from '@prisma/client';
import Decimal from 'decimal.js';

export type PricingComponentSource = {
  componentType: PricingComponentType;
  sourceConfigId: number;
  quantity: number | null;
  sourceSysConf: {
    config: {
      conf: string;
    };
  };
};

export type PieceComponentInput = {
  idSystem: number;
  idConfig: number;
  configName: string;
  dimensionMode: DimensionMode;
  pricingComponents: PricingComponentSource[];
  width?: unknown;
  height?: unknown;
  heightLeft?: unknown;
  heightRight?: unknown;
  legHeight?: unknown;
  doorWidth?: unknown;
  doorHeight?: unknown;
  leftSideliteWidth?: unknown;
  rightSideliteWidth?: unknown;
  leftPanels?: unknown;
  rightPanels?: unknown;
  panelCount?: unknown;
  lengthIn?: unknown;
};

export type ResolvedPieceComponent = {
  idSystem: number;
  idConfig: number;
  configName: string;
  componentType: PricingComponentType | null;
  componentIndex: number;
  componentLabel: string;
  widthIn: number | null;
  heightIn: number | null;
  heightLeftIn: number | null;
  heightRightIn: number | null;
  legHeightIn: number | null;
  panelCount: number | null;
  lengthIn: number | null;
};

function optionalPositiveNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;

  return number;
}

function positiveDecimal(value: unknown, label: string): Decimal {
  if (value === null || value === undefined || value === '') {
    throw new Error(`${label} is required.`);
  }

  const result = new Decimal(String(value));
  if (!result.isFinite() || result.lte(0)) {
    throw new Error(`${label} must be greater than zero.`);
  }

  return result;
}

function positiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) {
    throw new Error(`${label} must be a whole number greater than zero.`);
  }

  return result;
}

/**
 * Resolves a persisted Piece into the direct configurations that physically
 * compose it. The function consumes only SysConf metadata and Piece values;
 * it never interprets product, brand, system or configuration names.
 */
export function resolvePieceComponents(
  input: PieceComponentInput,
): ResolvedPieceComponent[] {
  const pricingComponents = input.pricingComponents ?? [];

  if (pricingComponents.length === 0) {
    return [
      {
        idSystem: input.idSystem,
        idConfig: input.idConfig,
        configName: input.configName,
        componentType: null,
        componentIndex: 1,
        componentLabel: input.configName,
        widthIn: optionalPositiveNumber(input.width),
        heightIn: optionalPositiveNumber(input.height),
        heightLeftIn: optionalPositiveNumber(input.heightLeft),
        heightRightIn: optionalPositiveNumber(input.heightRight),
        legHeightIn: optionalPositiveNumber(input.legHeight),
        panelCount: optionalPositiveNumber(input.panelCount),
        lengthIn:
          optionalPositiveNumber(input.lengthIn) ??
          optionalPositiveNumber(input.width),
      },
    ];
  }

  const totalWidth = positiveDecimal(input.width, 'Opening Width');
  const totalHeight = positiveDecimal(input.height, 'Opening Height');
  const result: ResolvedPieceComponent[] = [];

  const hasSidelite = pricingComponents.some(
    (component) =>
      component.componentType === PricingComponentType.SIDELITE,
  );

  const pushComponent = (
    component: PricingComponentSource,
    widthIn: Decimal,
    labelSuffix?: string,
    panelCount?: number | null,
  ) => {
    const componentIndex = result.length + 1;
    const configName = component.sourceSysConf.config.conf;

    result.push({
      idSystem: input.idSystem,
      idConfig: component.sourceConfigId,
      configName,
      componentType: component.componentType,
      componentIndex,
      componentLabel: labelSuffix
        ? `${configName} (${labelSuffix})`
        : configName,
      widthIn: widthIn.toNumber(),
      heightIn: totalHeight.toNumber(),
      heightLeftIn: null,
      heightRightIn: null,
      legHeightIn: null,
      panelCount: panelCount ?? null,
      lengthIn: widthIn.toNumber(),
    });
  };

  for (const component of pricingComponents) {
    if (component.componentType === PricingComponentType.DOOR) {
      const width =
        input.dimensionMode === DimensionMode.ECO_WINDOWS_DOOR &&
        !hasSidelite
          ? totalWidth
          : positiveDecimal(input.doorWidth, 'Door Width');

      pushComponent(
        component,
        width,
        undefined,
        optionalPositiveNumber(input.panelCount),
      );
      continue;
    }

    if (component.componentType !== PricingComponentType.SIDELITE) {
      throw new Error(
        `Unsupported pricing component type: ${component.componentType}.`,
      );
    }

    if (input.dimensionMode === DimensionMode.ECO_WINDOWS_DOOR) {
      const quantity = positiveInteger(
        component.quantity,
        'Sidelite Quantity',
      );
      const doorWidth = positiveDecimal(input.doorWidth, 'Door Width');
      const remainingWidth = totalWidth.minus(doorWidth);

      if (remainingWidth.lte(0)) {
        throw new Error(
          'Opening Width must be greater than Door Width when sidelites are used.',
        );
      }

      const width = remainingWidth.div(quantity);
      for (let index = 1; index <= quantity; index += 1) {
        pushComponent(component, width, `Sidelite ${index}`);
      }
      continue;
    }

    if (input.dimensionMode === DimensionMode.ECO_NOVO_DOOR) {
      let added = 0;

      const addSide = (
        widthValue: unknown,
        quantityValue: unknown,
        side: string,
      ) => {
        if (
          (widthValue === null || widthValue === undefined || widthValue === '') &&
          (quantityValue === null || quantityValue === undefined || Number(quantityValue) === 0)
        ) {
          return;
        }

        const width = positiveDecimal(widthValue, `${side} Sidelite Width`);
        const quantity = positiveInteger(
          quantityValue,
          `${side} Sidelite Qty`,
        );

        for (let index = 1; index <= quantity; index += 1) {
          pushComponent(component, width, `${side} ${index}`);
          added += 1;
        }
      };

      addSide(input.leftSideliteWidth, input.leftPanels, 'Left');
      addSide(input.rightSideliteWidth, input.rightPanels, 'Right');

      if (added === 0) {
        throw new Error(
          'At least one sidelite panel is required for component pricing.',
        );
      }

      continue;
    }

    throw new Error(
      'Sidelite component pricing is not supported for this dimension mode.',
    );
  }

  return result;
}
