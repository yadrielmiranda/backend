export type AdditionalServiceLineInput = {
  serviceId: number;
  widthIn?: number;
  heightIn?: number;
  areaSqFt?: number;
  panelCount?: number;
  lengthIn?: number;
  occurrences?: number;
  description?: string;
};

type StoredAdditionalServiceLine = {
  serviceId: number;
  widthIn: { toString(): string } | number | string | null;
  heightIn: { toString(): string } | number | string | null;
  areaSqFt: { toString(): string } | number | string | null;
  panelCount: number | null;
  lengthIn: { toString(): string } | number | string | null;
  occurrences: number;
  description: string | null;
};

const numeric = (
  value: { toString(): string } | number | string | null,
): number | undefined => (value == null ? undefined : Number(value.toString()));

export function additionalServicePricingDimensions(
  input: AdditionalServiceLineInput,
) {
  return {
    widthIn: input.widthIn,
    heightIn: input.heightIn,
    areaSqFt: input.areaSqFt,
    panelCount: input.panelCount,
    lengthIn: input.lengthIn,
  };
}

export function additionalServiceInputFromStoredLine(
  line: StoredAdditionalServiceLine,
): AdditionalServiceLineInput {
  return {
    serviceId: line.serviceId,
    widthIn: numeric(line.widthIn),
    heightIn: numeric(line.heightIn),
    areaSqFt: numeric(line.areaSqFt),
    panelCount: line.panelCount ?? undefined,
    lengthIn: numeric(line.lengthIn),
    occurrences: line.occurrences,
    description: line.description ?? undefined,
  };
}
