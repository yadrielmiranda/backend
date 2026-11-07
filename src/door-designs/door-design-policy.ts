import { FrenchDoorDesignKind, Prisma } from '@prisma/client';

export const DOOR_PRICE = /^\d{1,10}(?:\.\d{1,2})?$/;

type DiagramProduct = { diagramFamily: string; kind: string };

export function isFrenchDoorProduct(product?: DiagramProduct | null) {
  return product?.kind === 'GLAZED_UNIT' && product.diagramFamily === 'FRENCH_DOOR';
}

export function frenchDoorKind(product: DiagramProduct | null | undefined, configuration: string, dimensionMode: string): FrenchDoorDesignKind | null {
  if (!isFrenchDoorProduct(product)) return null;
  if (!['STANDARD', 'ECO_WINDOWS_DOOR', 'ECO_NOVO_DOOR'].includes(dimensionMode)) return null;
  const code = configuration.trim().toUpperCase().replace(/[\s_\-/]+/g, '');
  const match = /^O*(XX?)O*$/.exec(code);
  if (!match || code.length - match[1].length + 1 > 128) return null;
  return match[1] === 'X' ? 'SINGLE' : 'DOUBLE';
}

// Estimate pickers get identity and artwork, never the underlying cost.
export const DOOR_DESIGN_PICKER = {
  where: { unitPrice: { not: null } },
  select: { id: true, code: true, artworkKey: true, kind: true },
  orderBy: { code: 'asc' },
} satisfies Prisma.FrenchDoorDesignFindManyArgs;

export type DoorDesignSeries = {
  allowDesign: boolean;
  brandProduct: { product: DiagramProduct & { id: number } };
};
type DoorConfiguration = { dimensionMode: string; config: { idProduct: number; conf: string } };

export function seriesDoorDesignKind(system: DoorDesignSeries, configuration: DoorConfiguration) {
  const product = system?.brandProduct?.product;
  if (!system?.allowDesign || !product || configuration.config?.idProduct !== product.id) return null;
  return frenchDoorKind(product, configuration.config.conf, configuration.dimensionMode);
}
