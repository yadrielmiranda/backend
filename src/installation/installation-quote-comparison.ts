import Decimal from 'decimal.js';

type Snapshot = Record<string, unknown>;

function number(value: unknown): string | null {
  return value == null ? null : new Decimal(String(value)).toString();
}

function numbers(value: Snapshot, fields: readonly string[]) {
  return Object.fromEntries(fields.map((field) => [field, number(value[field])]));
}

// Se compara el alcance y cada precio; dos cambios que se compensan en el
// total siguen siendo cambios. Los identificadores de filas y las etiquetas
// de las piezas no forman parte de esta comparación.
export function installationQuoteContent(quote: Snapshot & { lines: Snapshot[] }): string {
  const lines = quote.lines.map((line) => JSON.stringify({
    ...numbers(line, [
      'serviceId', 'measurementId', 'sourceSystemId', 'sourceConfigId',
      'componentIndex', 'widthIn', 'heightIn', 'areaSqFt', 'panelCount',
      'lengthIn', 'metricValue', 'rate', 'billableQuantity', 'occurrences',
      'baseAmount', 'adjustmentPercent', 'adjustedAmount',
    ]),
    origin: line.origin,
    billingUnit: line.billingUnitSnapshot,
    metric: line.ruleMetricSnapshot,
    // La descripción automática contiene la Mark, que es solo identificativa.
    description: line.origin === 'AUTO' ? null : String(line.description ?? '').trim(),
  })).sort();
  return JSON.stringify({
    ...numbers(quote, [
      'profileAdjustmentPercent', 'profileMinimumSnapshot', 'baseSubtotal',
      'adjustedSubtotal', 'serviceMinimumAdjustment', 'minimumAdjustment', 'installationSurcharge', 'total',
    ]),
    lines,
  });
}
