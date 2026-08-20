import { BadRequestException } from "@nestjs/common";

export type ResolvePiecePanelCountInput = {
  fixedPanelCount?: number | string | null;
  requiresPanelCount: boolean;
  requestedPanelCount?: number | string | null;
};

function positiveIntegerOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numericValue = Number(value);

  return Number.isInteger(numericValue) && numericValue >= 1
    ? numericValue
    : null;
}

/**
 * Resolves the panel count stored on a piece.
 *
 * A fixed value configured on Config always wins. Otherwise, a manual value is
 * accepted only when the System/Config link explicitly requires it. Returning
 * null also clears stale values when the selected configuration does not use a
 * panel count.
 */
export function resolvePiecePanelCount({
  fixedPanelCount,
  requiresPanelCount,
  requestedPanelCount,
}: ResolvePiecePanelCountInput): number | null {
  if (fixedPanelCount !== null && fixedPanelCount !== undefined) {
    const configuredValue = positiveIntegerOrNull(fixedPanelCount);

    if (configuredValue === null) {
      throw new BadRequestException(
        "Fixed Panel Count for the selected configuration must be a whole number greater than zero.",
      );
    }

    return configuredValue;
  }

  if (!requiresPanelCount) {
    return null;
  }

  const requestedValue = positiveIntegerOrNull(requestedPanelCount);

  if (requestedValue === null) {
    throw new BadRequestException(
      "Panel Count must be a whole number greater than zero.",
    );
  }

  return requestedValue;
}
