import { BadRequestException } from '@nestjs/common';

export const MAX_PARTS = 200;

export type FactoryPartType = 'DOOR' | 'FRAME' | 'WINDOW';

export function parseFactoryBarcode(value: unknown): {
  lineNumber: string;
  partType?: FactoryPartType;
} {
  if (typeof value !== 'string')
    throw new BadRequestException('Scan or enter a factory barcode.');
  const match = value.trim().match(/^(?:I(\d{1,50})|(\d{1,50})(?:-(DOOR|FRAME|WINDOW))?)$/i);
  const digits = match?.[1] ?? match?.[2];
  if (!digits || /^0+$/.test(digits))
    throw new BadRequestException(
      'Use a factory line number, I followed by the line number, or a line number followed by -DOOR, -FRAME or -WINDOW.',
    );
  return {
    lineNumber: digits.replace(/^0+(?=\d)/, ''),
    ...(match?.[3] ? { partType: match[3].toUpperCase() as FactoryPartType } : {}),
  };
}

export function barcodeLine(value: unknown): string {
  return parseFactoryBarcode(value).lineNumber;
}

export type PartsSource = {
  family: string;
  panelCount?: number | null;
  fixedPanelCount?: number | null;
};

const positive = (n: unknown): n is number =>
  Number.isInteger(n) && Number(n) > 0 && Number(n) < MAX_PARTS;

export function expectedPhysicalParts(
  piece: PartsSource,
  factoryPanels?: number | null,
): number | null {
  // Solo se aceptan cantidades explícitas: JSON, pieza o configuración.
  // El nombre del producto y las letras O/X no determinan los paneles.
  const panels = [factoryPanels, piece.panelCount, piece.fixedPanelCount].find(
    positive,
  );
  if (panels === undefined) return null;

  // French Door y Sliding se reciben con un marco separado, según lo acordado.
  // Esta regla añade el marco; nunca deduce ni reemplaza la cantidad de paneles.
  const separateFrame =
    piece.family === 'FRENCH_DOOR' || piece.family === 'SLIDING_DOOR';
  return panels + (separateFrame ? 1 : 0);
}

export function assertBalances(stock: {
  expectedParts: number | null;
  inTransit: number;
  onHand: number;
  released: number;
}) {
  if (!stock.expectedParts || stock.expectedParts > MAX_PARTS)
    throw new BadRequestException(
      'An administrator must set the expected physical parts for this unit first.',
    );
  if (
    [stock.inTransit, stock.onHand, stock.released].some(
      (n) => !Number.isInteger(n) || n < 0,
    )
  )
    throw new BadRequestException(
      'This movement would leave a negative quantity.',
    );
  if (stock.inTransit + stock.onHand + stock.released > stock.expectedParts)
    throw new BadRequestException(
      'All expected parts for this unit are already accounted for.',
    );
}
