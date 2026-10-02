import { BadRequestException } from '@nestjs/common';

export type WindowWallMuntinGeometry = {
  panelCount: number;
  horizontalHeights?: readonly number[] | null;
  totalHeight: number;
};

export type WindowWallMuntinPanel = {
  panelIndex: number;
  panelCode: string;
  panelLabel: string;
};

type IncomingPanel = {
  panelIndex?: number;
  panelCode?: string | null;
  panelLabel?: string;
  horizontalLites?: number;
  verticalLites?: number;
};

const UNIFORM_PANEL: WindowWallMuntinPanel = {
  panelIndex: 1,
  panelCode: 'O',
  panelLabel: 'All glass panels',
};

export function buildWindowWallMuntinLayout(
  panelCount: number,
  horizontalHeights: readonly number[] | null | undefined,
  totalHeight: number,
): WindowWallMuntinPanel[] {
  if (!Number.isSafeInteger(panelCount) || panelCount < 1)
    throw new BadRequestException('Panel Count must be a whole number greater than zero.');
  if (!Number.isFinite(totalHeight) || totalHeight <= 0)
    throw new BadRequestException('Height must be greater than zero for the Window Wall muntin layout.');
  if (horizontalHeights != null && !Array.isArray(horizontalHeights))
    throw new BadRequestException('Horizontal Heights must be an array.');
  const positions = horizontalHeights ?? [];
  if (positions.some(value => !Number.isFinite(value) || value <= 0 || value >= totalHeight))
    throw new BadRequestException('Horizontal Heights must be finite positions greater than zero and less than Height.');
  if (new Set(positions).size !== positions.length)
    throw new BadRequestException('Horizontal Heights cannot contain duplicate positions.');
  const rows = positions.length + 1;
  if (!Number.isSafeInteger(panelCount * rows))
    throw new BadRequestException('The Window Wall muntin layout has an invalid number of glass cells.');

  // Window Wall stores one grid specification, repeated in every glass cell.
  // The physical divisions remain part of the piece dimensions, not this layout.
  return [{ ...UNIFORM_PANEL }];
}

export function normalizeWindowWallMuntinPanels(
  incomingPanels: readonly IncomingPanel[] = [],
) {
  for (const panel of incomingPanels) {
    if (!panel || ![panel.horizontalLites, panel.verticalLites].every(value => Number.isSafeInteger(value) && value! >= 1))
      throw new BadRequestException('Window Wall muntin lite counts must be positive whole numbers.');
  }

  const first = incomingPanels[0];
  if (first && incomingPanels.some(panel => panel.horizontalLites !== first.horizontalLites || panel.verticalLites !== first.verticalLites))
    throw new BadRequestException('Window Wall uses one muntin grid for all glass panels. Reconfigure the saved grids to use the same horizontal and vertical lite counts.');

  return [{
    ...UNIFORM_PANEL,
    horizontalLites: first?.horizontalLites ?? 1,
    verticalLites: first?.verticalLites ?? 1,
  }];
}
